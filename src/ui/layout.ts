import type { Graph } from '../core/graph.js';
import type { NodeId } from '../core/types.js';
import { COLUMN_GAP, NODE_WIDTH, ROW_GAP, inputPortY, nodeHeight, outputPortY } from './metrics.js';

/**
 * Layered left-to-right placement: a node sits one column right of its
 * deepest producer, so wires always flow forwards and the graph reads as an
 * ordered feature history.
 */
export function autoLayout(graph: Graph): void {
  const order = graph.topologicalOrder();

  const depth = new Map<NodeId, number>();
  for (const nodeId of order) {
    let deepest = 0;
    for (const edge of graph.incomingEdges(nodeId)) {
      deepest = Math.max(deepest, (depth.get(edge.from.node) ?? 0) + 1);
    }
    depth.set(nodeId, deepest);
  }

  const columns = new Map<number, NodeId[]>();
  for (const nodeId of order) {
    const column = depth.get(nodeId) ?? 0;
    const bucket = columns.get(column);
    if (bucket === undefined) columns.set(column, [nodeId]);
    else bucket.push(nodeId);
  }

  for (const [column, nodeIds] of columns) {
    let y = 0;
    for (const nodeId of nodeIds) {
      graph.setPosition(nodeId, { x: column * (NODE_WIDTH + COLUMN_GAP), y });
      y += nodeHeight(graph.schemaOf(nodeId)) + ROW_GAP;
    }
  }
}

/** Free space to the right of everything placed so far. */
export function nextFreePosition(graph: Graph): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const node of graph.allNodes()) {
    x = Math.max(x, node.position.x);
    y = Math.max(y, node.position.y);
  }
  return graph.nodeCount === 0 ? { x: 0, y: 0 } : { x: x + NODE_WIDTH + COLUMN_GAP, y };
}

// ------------------------------------------------------------ the live layout

type Position = { x: number; y: number };

/** One column step: a node's width and the gap a wire runs across. */
const STEP = NODE_WIDTH + COLUMN_GAP;
/**
 * How hard a wire to a pinned node pulls on the node at its other end. A pin
 * is somewhere the person put one node; at full strength its wires would drag
 * the whole chain after it to straighten themselves, and the rest of the graph
 * would chase the node instead of making room for it.
 */
const TO_PINNED = 0.12;
/** A pinned node does not move; its weight makes the arithmetic agree. */
const FIXED = 1e6;
/** Rounds of ordering and relaxing; the layout has settled well before this. */
const ROUNDS = 40;

export interface LayoutOptions {
  /** Positions to hold as if pinned, such as a node being dragged right now. */
  hold?: ReadonlyMap<NodeId, Position>;
  /**
   * Nodes that have never been laid out. Where they are is wherever they were
   * dropped when made, which says nothing about where they belong, so they are
   * not held towards it — held, a new node below everything else drags its
   * whole chain down a little each time one is made.
   */
  fresh?: ReadonlySet<NodeId>;
}

/**
 * Where every node should be.
 *
 * The aim is the one a person tidying the graph by hand would have: wires short,
 * nothing on top of anything else, and as few crossings as is reasonable — while
 * leaving alone whatever the person has placed themselves.
 *
 * - **Columns come from the wiring.** A node is at least one column right of
 *   everything it reads, so the graph reads left to right as a history, and a
 *   node spliced into a chain pushes what comes after it along. A node with
 *   nothing upstream of it — a profile, a parameter — is pulled right to sit
 *   just before the first thing that reads it, instead of being left at the
 *   far left with a long wire.
 * - **Heights come from the wires.** Each node is pulled to where its ports
 *   line up with the ports it is wired to, which is what makes a wire short and
 *   straight. Sorting a column by that pull is the barycentre heuristic, which
 *   is what takes most crossings out.
 * - **Nothing overlaps.** A column is laid out top to bottom with a margin
 *   between nodes, moving each as little as it can from where it wants to be.
 * - **Pinned nodes stay put**, and everything else is laid out around them.
 */
export function planLayout(graph: Graph, options: LayoutOptions = {}): Map<NodeId, Position> {
  const order = graph.topologicalOrder();
  const nodes = new Map(graph.allNodes().map((node) => [node.id, node]));
  const fixed = new Map<NodeId, Position>();
  for (const node of nodes.values()) {
    const held = options.hold?.get(node.id);
    if (held !== undefined) fixed.set(node.id, held);
    else if (node.pinned === true) fixed.set(node.id, node.position);
  }
  const height = (nodeId: NodeId): number => nodeHeight(graph.schemaOf(nodeId));

  // ---- columns: forwards for the earliest each node may be, backwards to pull
  // whatever starts a branch up against the first thing that reads it.
  const x = new Map<NodeId, number>();
  for (const nodeId of order) {
    const pinned = fixed.get(nodeId);
    if (pinned !== undefined) {
      x.set(nodeId, pinned.x);
      continue;
    }
    let earliest = 0;
    for (const edge of graph.incomingEdges(nodeId)) {
      earliest = Math.max(earliest, (x.get(edge.from.node) ?? 0) + STEP);
    }
    // Not snapped to the next whole column: after a node pinned a little off
    // the grid, the next one moves only as far as it has to, rather than a
    // whole column — which would drag every node behind it along too.
    x.set(nodeId, earliest);
  }
  for (const nodeId of [...order].reverse()) {
    if (fixed.has(nodeId)) continue;
    const readers = graph.outgoingEdges(nodeId).map((edge) => x.get(edge.to.node) ?? 0);
    if (readers.length === 0) continue;
    const latest = Math.floor((Math.min(...readers) - STEP) / STEP + 1e-9) * STEP;
    x.set(nodeId, Math.max(x.get(nodeId)!, latest));
  }

  // ---- heights.
  const y = new Map<NodeId, number>();
  for (const node of nodes.values()) y.set(node.id, fixed.get(node.id)?.y ?? node.position.y);

  // Where a node's top wants to be: level with the ports it is wired to.
  const wanted = (nodeId: NodeId): number => {
    const schema = graph.schemaOf(nodeId);
    const here = y.get(nodeId)!;
    let sum = 0;
    let weight = 0;
    const pull = (other: NodeId): number => (fixed.has(other) ? TO_PINNED : 1);
    for (const edge of graph.incomingEdges(nodeId)) {
      const from = graph.schemaOf(edge.from.node);
      const w = pull(edge.from.node);
      sum += w * (y.get(edge.from.node)! + outputPortY(from, edge.from.port) - inputPortY(schema, edge.to.port));
      weight += w;
    }
    for (const edge of graph.outgoingEdges(nodeId)) {
      const to = graph.schemaOf(edge.to.node);
      const w = pull(edge.to.node);
      sum += w * (y.get(edge.to.node)! + inputPortY(to, edge.to.port) - outputPortY(schema, edge.from.port));
      weight += w;
    }
    // Nothing to go by at all: stay put.
    return weight === 0 ? here : sum / weight;
  };

  const columnXs = [...new Set([...x.entries()].filter(([id]) => !fixed.has(id)).map(([, value]) => value))].sort(
    (a, b) => a - b,
  );
  const columnOf = (column: number): NodeId[] => {
    // A pinned node is an obstacle in every column it overlaps sideways.
    return [...nodes.keys()].filter((id) =>
      fixed.has(id) ? Math.abs(x.get(id)! - column) < NODE_WIDTH + COLUMN_GAP / 2 : x.get(id) === column,
    );
  };

  // Wires decide the shape of each connected group, but not where the group
  // as a whole sits — any height would straighten them equally well. That is
  // decided by keeping the group's average height where its members already
  // were, so nothing moves for no reason. Counted per group, not per node: a
  // per-node hold strong enough to keep a group in place would stop a chain
  // lining up, and one weak enough to let it line up lets anything else — a
  // node made far away, a pinned neighbour — drag the whole group after it.
  const groups = groupsOf(graph, (id) => !fixed.has(id));
  const recentre = (): void => {
    for (const members of groups) {
      const placed = members.filter((id) => options.fresh?.has(id) !== true);
      if (placed.length === 0) continue;
      let shift = 0;
      for (const id of placed) shift += nodes.get(id)!.position.y - y.get(id)!;
      shift /= placed.length;
      for (const id of members) y.set(id, y.get(id)! + shift);
    }
  };

  for (let round = 0; round < ROUNDS; round++) {
    recentre();
    const sweep = round % 2 === 0 ? columnXs : [...columnXs].reverse();
    for (const column of sweep) {
      const members = columnOf(column);
      const items = members.map((id) => ({
        id,
        h: height(id),
        want: fixed.has(id) ? fixed.get(id)!.y : wanted(id),
        weight: fixed.has(id) ? FIXED : 1,
      }));
      // Sorting by where each wants to be is the barycentre ordering.
      items.sort((a, b) => a.want + a.h / 2 - (b.want + b.h / 2) || a.id.localeCompare(b.id));
      for (const [id, top] of separate(items)) {
        if (!fixed.has(id)) y.set(id, top);
      }
    }
  }

  const plan = new Map<NodeId, Position>();
  for (const nodeId of nodes.keys()) {
    const held = fixed.get(nodeId);
    plan.set(nodeId, held ?? { x: x.get(nodeId)!, y: Math.round(y.get(nodeId)!) });
  }
  return plan;
}

/** The nodes `include` admits, in groups connected by wires among themselves. */
function groupsOf(graph: Graph, include: (nodeId: NodeId) => boolean): NodeId[][] {
  const seen = new Set<NodeId>();
  const groups: NodeId[][] = [];
  for (const node of graph.allNodes()) {
    if (seen.has(node.id) || !include(node.id)) continue;
    const group: NodeId[] = [];
    const stack = [node.id];
    seen.add(node.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      group.push(id);
      const neighbours = [
        ...graph.incomingEdges(id).map((edge) => edge.from.node),
        ...graph.outgoingEdges(id).map((edge) => edge.to.node),
      ];
      for (const next of neighbours) {
        if (seen.has(next) || !include(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Tops for a column of nodes, in the order given, with a margin between each,
 * each as close as it can be to where it wants to be.
 *
 * Overlapping neighbours are merged into a block that moves as one, placed at
 * the weighted mean of where its members want it — the least total movement
 * that leaves them apart. A pinned member's weight dwarfs the rest, so a block
 * holding one stays where that node is.
 */
function separate(
  items: ReadonlyArray<{ id: NodeId; h: number; want: number; weight: number }>,
): Map<NodeId, number> {
  interface Block {
    members: Array<{ id: NodeId; offset: number }>;
    height: number;
    sum: number;
    weight: number;
  }
  const at = (block: Block): number => block.sum / block.weight;

  const blocks: Block[] = [];
  for (const item of items) {
    let block: Block = {
      members: [{ id: item.id, offset: 0 }],
      height: item.h,
      sum: item.weight * item.want,
      weight: item.weight,
    };
    let previous = blocks[blocks.length - 1];
    while (previous !== undefined && at(previous) + previous.height + ROW_GAP > at(block)) {
      blocks.pop();
      const shift = previous.height + ROW_GAP;
      block = {
        members: [...previous.members, ...block.members.map((m) => ({ id: m.id, offset: m.offset + shift }))],
        height: shift + block.height,
        sum: previous.sum + block.sum - shift * block.weight,
        weight: previous.weight + block.weight,
      };
      previous = blocks[blocks.length - 1];
    }
    blocks.push(block);
  }

  const tops = new Map<NodeId, number>();
  for (const block of blocks) {
    for (const member of block.members) tops.set(member.id, at(block) + member.offset);
  }
  return tops;
}
