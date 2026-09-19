import { describe, expect, it } from 'vitest';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import type { NodeSchema } from '../core/types.js';
import { constrainedSchemas } from '../nodes/constrained.js';
import { edgeSchemas } from '../nodes/edges.js';
import { mathNodes } from '../nodes/math.js';
import { modifySchemas } from '../nodes/modify.js';
import { planeNodes } from '../nodes/plane.js';
import { geometrySchemas } from '../nodes/solid.js';
import { specForNode } from './features.js';

/** The real schemas, without the kernel: what is being asked is about ports. */
function setup(): Graph {
  const registry = new NodeRegistry<NodeSchema>();
  registry.registerAll(mathNodes);
  registry.registerAll(planeNodes);
  registry.registerAll(geometrySchemas);
  registry.registerAll(modifySchemas);
  registry.registerAll(edgeSchemas);
  registry.registerAll(constrainedSchemas);
  return new Graph(registry);
}

describe('which nodes reopen in a dialog', () => {
  it('finds the dialog that built a feature', () => {
    const graph = setup();
    const fillet = graph.addNode('solid.fillet');
    const extrude = graph.addNode('solid.extrude');
    const move = graph.addNode('solid.move');

    expect(specForNode(graph, fillet.id)?.label).toBe('Fillet');
    expect(specForNode(graph, extrude.id)?.label).toBe('Extrude');
    expect(specForNode(graph, move.id)?.label).toBe('Move');
  });

  it('offers nothing for a node no dialog builds', () => {
    const graph = setup();
    const number = graph.addNode('math.number');
    const selection = graph.addNode('edge.selection');

    expect(specForNode(graph, number.id)).toBeNull();
    expect(specForNode(graph, selection.id)).toBeNull();
  });

  it('leaves a sketch to its own kind of dialog', () => {
    const graph = setup();
    const sketch = graph.addNode('sketch.constrained', {
      inputs: { points: [], entities: [], constraints: [], dims: [] },
    });

    // A drawn sketch reopens in the drawing session, not in a form of numbers.
    expect(specForNode(graph, sketch.id)).toBeNull();
  });

  it('reopens a parametric profile, which is a form of numbers', () => {
    const graph = setup();
    const rectangle = graph.addNode('sketch.rectangle');

    expect(specForNode(graph, rectangle.id)?.label).toBe('Rectangle');
  });
});
