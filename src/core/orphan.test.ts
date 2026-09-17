import { describe, expect, it } from 'vitest';
import { constrainedSchemas } from '../nodes/constrained.js';
import type { SerializedGraph } from './graph.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';
import type { NodeSchema } from './types.js';

function sketchGraph(): Graph {
  const registry = new NodeRegistry<NodeSchema>();
  registry.registerAll(constrainedSchemas);
  return new Graph(registry);
}

const SQUARE = {
  points: [0, 0, 60, 0, 60, 40, 0, 40],
  entities: [
    ['line', 0, 1],
    ['line', 1, 2],
    ['line', 2, 3],
    ['line', 3, 0],
  ],
};

describe('a dimension that has been removed', () => {
  it('does not leave its number behind on the node', () => {
    const graph = sketchGraph();
    const sketch = graph.addNode('sketch.constrained', {
      inputs: {
        ...SQUARE,
        constraints: [['lockU', 0, 'originU'], ['distance', 0, 1, 'length1']],
        dims: ['originU', 0, 'length1', 60],
      },
    });
    expect(graph.schemaOf(sketch.id).inputs.map((p) => p.id)).toContain('d_length1');

    // The length is deleted in the sketch editor: the rule goes, and so should
    // the number that only that rule gave meaning to.
    graph.setInput(sketch.id, 'constraints', [['lockU', 0, 'originU']]);

    expect(Object.keys(graph.requireNode(sketch.id).inputs)).not.toContain('d_length1');
  });

  it('leaves a document that can be opened again', () => {
    const graph = sketchGraph();
    const sketch = graph.addNode('sketch.constrained', {
      inputs: {
        ...SQUARE,
        constraints: [['lockU', 0, 'originU'], ['distance', 0, 1, 'length1']],
        dims: ['originU', 0, 'length1', 60],
      },
    });
    graph.setInput(sketch.id, 'd_length1', 45);
    graph.setInput(sketch.id, 'constraints', [['lockU', 0, 'originU']]);

    const saved = JSON.parse(JSON.stringify(graph.toJSON()));
    expect(() => sketchGraph().restore(saved)).not.toThrow();
  });

  it('opens a document that already had one left behind', () => {
    // What earlier builds wrote: a literal for a port the node no longer grows.
    const damaged: SerializedGraph = {
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'sketch.constrained',
          position: { x: 0, y: 0 },
          inputs: {
            ...SQUARE,
            constraints: [['lockU', 0, 'originU']],
            dims: ['originU', 0],
            d_length1: 45,
          },
        },
      ],
      edges: [],
    };

    const graph = sketchGraph();
    expect(() => graph.restore(damaged)).not.toThrow();
    expect(Object.keys(graph.requireNode('n1').inputs)).not.toContain('d_length1');
  });
});
