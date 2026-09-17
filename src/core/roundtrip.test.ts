import { describe, expect, it } from 'vitest';
import { constrainedSchemas } from '../nodes/constrained.js';
import { edgeSchemas } from '../nodes/edges.js';
import { faceSchemas } from '../nodes/face.js';
import { mathNodes } from '../nodes/math.js';
import { modifySchemas } from '../nodes/modify.js';
import { planeNodes } from '../nodes/plane.js';
import { geometrySchemas } from '../nodes/solid.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';
import type { NodeSchema } from './types.js';

function app(): Graph {
  const registry = new NodeRegistry<NodeSchema>();
  registry.registerAll(mathNodes);
  registry.registerAll(planeNodes);
  registry.registerAll(geometrySchemas);
  registry.registerAll(faceSchemas);
  registry.registerAll(modifySchemas);
  registry.registerAll(edgeSchemas);
  registry.registerAll(constrainedSchemas);
  return new Graph(registry);
}

/** One of everything the toolbar can put in a document. */
function populate(graph: Graph): void {
  const plane = graph.addNode('plane.xy');
  const sketch = graph.addNode('sketch.constrained', {
    inputs: {
      points: [0, 0, 60, 0, 60, 40, 0, 40],
      entities: [
        ['line', 0, 1],
        ['line', 1, 2],
        ['line', 2, 3],
        ['line', 3, 0],
      ],
      constraints: [
        ['lockU', 0, 'originU'],
        ['lockV', 0, 'originV'],
        ['distance', 0, 1, 'length1'],
      ],
      dims: ['originU', 0, 'originV', 0, 'length1', 60],
    },
  });
  graph.connect({ node: plane.id, port: 'plane' }, { node: sketch.id, port: 'plane' });

  const body = graph.addNode('solid.extrude', { inputs: { distance: 20 } });
  graph.connect({ node: sketch.id, port: 'profile' }, { node: body.id, port: 'profile' });

  const edges = graph.addNode('edge.selection', { inputs: { refs: [0, 0, 0, 1, 0, 0, 10] } });
  const fillet = graph.addNode('solid.fillet', { inputs: { radius: 2 } });
  graph.connect({ node: body.id, port: 'solid' }, { node: fillet.id, port: 'solid' });
  graph.connect({ node: edges.id, port: 'edges' }, { node: fillet.id, port: 'edges' });

  const face = graph.addNode('face.plane', { inputs: { nx: 0, ny: 0, nz: 1, rank: 0 } });
  graph.connect({ node: fillet.id, port: 'result' }, { node: face.id, port: 'solid' });

  graph.addNode('math.number', { label: 'Thickness', inputs: { value: 3 } });
}

describe('a document of everything', () => {
  it('reloads exactly as it was saved', () => {
    const graph = app();
    populate(graph);
    const saved = JSON.parse(JSON.stringify(graph.toJSON()));

    const reopened = app();
    reopened.restore(saved);

    expect(reopened.toJSON()).toEqual(graph.toJSON());
  });

  it('carries on numbering where the saved document left off', () => {
    const graph = app();
    populate(graph);

    const reopened = app();
    reopened.restore(JSON.parse(JSON.stringify(graph.toJSON())));
    const added = reopened.addNode('math.number');

    expect(reopened.getNode(added.id)).toBeDefined();
    expect(graph.getNode(added.id)).toBeUndefined();
  });

  it('leaves the document alone when a restore cannot be finished', () => {
    const graph = app();
    populate(graph);
    const before = graph.toJSON();

    // A document naming something this build does not have.
    const damaged = JSON.parse(JSON.stringify(before));
    damaged.nodes.push({ id: 'zz', type: 'solid.teleport', position: { x: 0, y: 0 }, inputs: {} });

    expect(() => graph.restore(damaged)).toThrow();
    expect(graph.toJSON()).toEqual(before);

    // And numbering still works, rather than colliding with a half-load.
    expect(() => graph.addNode('math.number')).not.toThrow();
  });
});
