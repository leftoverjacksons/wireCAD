import type { Graph } from './graph.js';
import type { DataType, Edge, NodeId, PortId } from './types.js';

/**
 * Putting a node into a chain that already exists, and taking one back out.
 *
 * Everything the toolbar builds so far is appended: a new feature reads what is
 * already there and becomes the new end of the chain. Two things people expect
 * of a modeller need more than that — moving a body that other features are
 * built on, and deleting a feature from the middle without losing what came
 * after it — and both are the same operation seen from either side.
 *
 * These live apart from the graph itself because the graph's job is to hold
 * nodes and wires and refuse the impossible. What a *chain* is, and which wire
 * a feature belongs on, is a question about what the nodes mean, which is one
 * level up.
 */

/**
 * The way something passes through a node: an input and an output carrying the
 * same kind of thing.
 *
 * A fillet takes a solid and hands one on, so a solid passes through it; an
 * extrude takes a sketch and hands on a solid, so nothing does — which is why a
 * deleted extrude cannot be healed over and a deleted fillet can.
 */
export interface PassThrough {
  input: PortId;
  output: PortId;
  type: DataType;
}

/**
 * How a node lets something of this type through, if it does.
 *
 * The first matching input wins, and node schemas list what a feature works on
 * before what it works with: a cut names its target before its tool, so the
 * thing being modified is the thing that passes through.
 */
export function passThroughOf(
  graph: Graph,
  nodeId: NodeId,
  type?: DataType,
): PassThrough | null {
  const schema = graph.schemaOf(nodeId);

  for (const output of schema.outputs) {
    if (type !== undefined && output.type !== type) continue;
    // An echoed output repeats an input rather than carrying work forward; it
    // is a reading of the node, not a way through it.
    if (output.echoes !== undefined) continue;

    const input = schema.inputs.find((port) => port.type === output.type);
    if (input === undefined) continue;
    return { input: input.id, output: output.id, type: output.type };
  }

  return null;
}

export interface SpliceResult {
  /** The output of the existing node that now feeds the inserted one. */
  from: PortId;
  /** The inserted node's input and output used to carry it on. */
  through: PassThrough;
  /** Consumers moved off the existing node and onto the inserted one. */
  moved: number;
}

/**
 * Puts `inserted` between `existing` and everything that was reading it.
 *
 * At the end of a chain, where nothing reads the node yet, this is an ordinary
 * append — which is the point: moving the body you can see and moving a body
 * three features back are the same operation, and only the number of consumers
 * differs.
 *
 * Either the whole splice happens or none of it does. A half-spliced graph is
 * worse than a refused one.
 */
export function spliceAfter(graph: Graph, existing: NodeId, inserted: NodeId): SpliceResult {
  if (existing === inserted) throw new Error('A node cannot be spliced after itself');
  graph.requireNode(existing);
  graph.requireNode(inserted);

  const through = passThroughOf(graph, inserted);
  if (through === null) {
    throw new Error('That node does not pass anything through, so nothing can be spliced into it');
  }
  if (graph.incomingEdge(inserted, through.input) !== undefined) {
    throw new Error('The node being spliced in already has something wired to its input');
  }

  const source = graph
    .schemaOf(existing)
    .outputs.find((port) => port.type === through.type && port.echoes === undefined);
  if (source === undefined) {
    throw new Error(`There is no ${through.type} here to splice onto`);
  }

  // Consumers first: they are what makes this a splice rather than an append,
  // and they have to be let go of before the new node can take their place.
  const consumers = graph
    .outgoingEdges(existing)
    .filter((edge) => edge.from.port === source.id);

  const problem = graph.canConnect(
    { node: existing, port: source.id },
    { node: inserted, port: through.input },
  );
  if (problem !== null) throw new Error(problem);

  const undo: Array<() => void> = [];
  const restore = (): void => {
    for (const step of undo.reverse()) step();
  };

  try {
    for (const edge of consumers) {
      const { id, from, to } = edge;
      graph.disconnect(id);
      undo.push(() => graph.connect(from, to, id));
    }

    const feed = graph.connect(
      { node: existing, port: source.id },
      { node: inserted, port: through.input },
    );
    undo.push(() => graph.disconnect(feed.id));

    for (const edge of consumers) {
      const carried = graph.connect({ node: inserted, port: through.output }, edge.to);
      undo.push(() => graph.disconnect(carried.id));
    }
  } catch (thrown) {
    restore();
    throw thrown;
  }

  return { from: source.id, through, moved: consumers.length };
}

export interface HealResult {
  /** Wires rewired to what the removed node was reading. */
  healed: number;
  /** Wires lost with it, because nothing could stand in their place. */
  stranded: number;
}

/**
 * Takes a node out and joins what it was reading to what was reading it.
 *
 * A fillet removed this way leaves the body it was rounding in its place, and
 * everything built on the fillet goes on being built on the body. Where nothing
 * can stand in — an extrude turns a sketch into a solid, and a sketch is no
 * substitute for a solid — the node goes anyway and the consumers are left
 * wanting an input, which is the truth about what just happened rather than a
 * refusal to do it.
 */
export function removeAndHeal(graph: Graph, nodeId: NodeId): HealResult {
  graph.requireNode(nodeId);

  const through = passThroughOf(graph, nodeId);
  const upstream = through === null ? undefined : graph.incomingEdge(nodeId, through.input);

  const wires = graph.outgoingEdges(nodeId);
  const candidates: Edge[] =
    through === null || upstream === undefined
      ? []
      : wires.filter((edge) => edge.from.port === through.output);

  // The node goes first. Its own wires go with it, which is what frees the
  // inputs the survivors are about to be wired to — asking beforehand would only
  // be told they are already spoken for, by the wire that is on its way out.
  graph.removeNode(nodeId);

  let healed = 0;
  for (const edge of candidates) {
    if (graph.canConnect(upstream!.from, edge.to) !== null) continue;
    graph.connect(upstream!.from, edge.to);
    healed += 1;
  }

  return { healed, stranded: wires.length - healed };
}

/**
 * Everything that would go with a node if it were removed outright: the node
 * and every node downstream of it that would have nothing left to read.
 *
 * What a menu needs to say before it takes something away.
 */
export function branchOf(graph: Graph, nodeId: NodeId): Set<NodeId> {
  const going = new Set<NodeId>([nodeId]);

  // Repeated passes, because a node is only lost once everything feeding it is,
  // and that can become true late.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.allNodes()) {
      if (going.has(node.id)) continue;

      const wired = graph.incomingEdges(node.id);
      if (wired.length === 0) continue;
      const survives = wired.some((edge) => !going.has(edge.from.node));
      if (survives) continue;

      going.add(node.id);
      changed = true;
    }
  }

  return going;
}
