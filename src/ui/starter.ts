import type { Graph } from '../core/graph.js';
import { autoLayout } from './layout.js';

/**
 * The model a fresh install opens with: a bored block.
 *
 * Every dimension a profile needs lives on the profile, and the bore is the same
 * Extrude node as the body with its operation set to Cut, so the whole part is
 * four nodes. Height is the exception, pulled out to a parameter so there is one
 * visible example of a dimension driven from elsewhere — which is the point of
 * the graph, and costs one node rather than seven.
 */
export function buildStarterModel(graph: Graph): void {
  const height = graph.addNode('math.number', { label: 'Height', inputs: { value: 20 } });

  const bodyProfile = graph.addNode('sketch.rectangle', {
    label: 'Body profile',
    inputs: { width: 60, height: 40 },
  });
  const body = graph.addNode('solid.extrude', {
    label: 'Body',
    inputs: { operation: 'New body' },
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
  graph.connect({ node: height.id, port: 'result' }, { node: body.id, port: 'distance' });

  graph.connect({ node: boreProfile.id, port: 'profile' }, { node: bore.id, port: 'profile' });
  graph.connect({ node: body.id, port: 'solid' }, { node: bore.id, port: 'target' });

  autoLayout(graph);
}
