import { describe, expect, it } from 'vitest';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import type { NodeDefinition } from '../core/types.js';
import { buildFeature } from './features.js';
import type { FeatureSpec } from './features.js';

/**
 * A feature that goes into the chain rather than onto the end of it.
 *
 * The kernel is not involved: what is being checked is where the wires end up,
 * which is a question about the graph.
 */
const nodes: NodeDefinition[] = [
  {
    type: 'test.block',
    label: 'Block',
    category: 'Test',
    inputs: [],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    type: 'test.move',
    label: 'Move',
    category: 'Test',
    inputs: [
      { id: 'solid', label: 'Solid', type: 'geometry' },
      { id: 'dx', label: 'X', type: 'number', default: 0 },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
    evaluate: () => ({ result: null }),
  },
  {
    type: 'test.bore',
    label: 'Bore',
    category: 'Test',
    inputs: [{ id: 'target', label: 'Target', type: 'geometry' }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
];

const moveSpec: FeatureSpec = {
  id: 'move',
  label: 'Move',
  nodeType: 'test.move',
  operands: [{ id: 'solid', label: 'Body', type: 'geometry' }],
  numbers: [{ id: 'dx', label: 'X', value: 0 }],
  splice: true,
};

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(nodes);
  return new Graph(registry);
}

describe('a feature that splices', () => {
  it('takes the operand’s consumers with it', () => {
    const graph = setup();
    const block = graph.addNode('test.block');
    const bore = graph.addNode('test.bore');
    graph.connect({ node: block.id, port: 'solid' }, { node: bore.id, port: 'target' });

    const move = buildFeature(
      graph,
      moveSpec,
      { solid: { node: block.id, port: 'solid' } },
      { dx: 5 },
    );

    // The block feeds the move, and the bore is cut from what the move handed
    // on — so the block moves and the bore goes with it.
    expect(graph.incomingEdge(move, 'solid')?.from.node).toBe(block.id);
    expect(graph.incomingEdge(bore.id, 'target')?.from.node).toBe(move);
  });

  it('is an ordinary append at the end of a chain', () => {
    const graph = setup();
    const block = graph.addNode('test.block');

    const move = buildFeature(
      graph,
      moveSpec,
      { solid: { node: block.id, port: 'solid' } },
      { dx: 5 },
    );

    expect(graph.incomingEdge(move, 'solid')?.from.node).toBe(block.id);
    expect(graph.outgoingEdges(move)).toHaveLength(0);
  });

  it('leaves nothing behind when it cannot be built', () => {
    const graph = setup();
    const block = graph.addNode('test.block');
    const before = graph.nodeCount;

    // Nothing of that name to splice onto: the half-built node goes.
    expect(() => buildFeature(graph, moveSpec, {}, { dx: 5 })).toThrow(/splice this onto/);
    expect(graph.nodeCount).toBe(before);
    expect(graph.outgoingEdges(block.id)).toHaveLength(0);
  });
});
