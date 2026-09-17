import type { Graph } from '../core/graph.js';
import { autoLayout } from './layout.js';

/**
 * The model a fresh install opens with: a bored block, in four nodes.
 *
 * Every dimension sits on the node that needs it, editable in place. Pulling a
 * dimension out to a parameter node is worth doing when two features have to
 * share it or when you want a slider, and the graph is there for that — but it
 * is a thing you choose, not the price of drawing a box.
 */
export function buildStarterModel(graph: Graph): void {
  const bodyProfile = graph.addNode('sketch.rectangle', {
    label: 'Body profile',
    inputs: { width: 60, height: 40 },
  });
  const body = graph.addNode('solid.extrude', {
    label: 'Body',
    inputs: { distance: 20, operation: 'New body' },
  });

  const boreProfile = graph.addNode('sketch.circle', {
    label: 'Bore profile',
    inputs: { radius: 8, u: 30, v: 20 },
  });
  const bore = graph.addNode('solid.extrude', {
    label: 'Bore',
    inputs: { distance: 40, operation: 'Cut' },
  });

  graph.connect({ node: bodyProfile.id, port: 'profile' }, { node: body.id, port: 'profile' });
  graph.connect({ node: boreProfile.id, port: 'profile' }, { node: bore.id, port: 'profile' });
  graph.connect({ node: body.id, port: 'solid' }, { node: bore.id, port: 'target' });

  autoLayout(graph);
}
