import type { Graph } from '../core/graph.js';
import type { NodeId } from '../core/types.js';
import { COLUMN_GAP, NODE_WIDTH, ROW_GAP, nodeHeight } from './metrics.js';

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
