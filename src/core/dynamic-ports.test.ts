import { describe, expect, it } from 'vitest';
import { mathNodes } from '../nodes/math.js';
import { polygonSchema, rectangleSchema } from '../nodes/solid.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';

function graphWith(): Graph {
  const registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  registry.registerAll([polygonSchema, rectangleSchema] as never);
  return new Graph(registry);
}

describe('profile dimensions', () => {
  it('grows one named pair of ports per drawn corner', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });

    const schema = graph.schemaOf(node.id);
    const labels = schema.inputs.filter((port) => port.hidden !== true).map((port) => port.label);
    expect(labels).toEqual(['Plane', 'P1 U', 'P1 V', 'P2 U', 'P2 V', 'P3 U', 'P3 V']);
  });

  it('defaults each dimension to the value it was drawn at', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });

    expect(graph.inputValue(node.id, 'p2u')).toBe(10);
    expect(graph.inputValue(node.id, 'p3v')).toBe(5);
  });

  it('lets one dimension be overridden without disturbing the others', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });

    graph.setInput(node.id, 'p2u', 25);
    expect(graph.inputValue(node.id, 'p2u')).toBe(25);
    expect(graph.inputValue(node.id, 'p3u')).toBe(10);
  });

  it('exposes each dimension as an output so it can drive something else', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });

    expect(graph.outputPortOf(node.id, 'p1u')).toBeDefined();
  });

  it('accepts a wire into a grown dimension', () => {
    const graph = graphWith();
    const profile = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });
    const parameter = graph.addNode('math.number', { inputs: { value: 42 } });

    expect(
      graph.canConnect(
        { node: parameter.id, port: 'result' },
        { node: profile.id, port: 'p2u' },
      ),
    ).toBeNull();
  });

  it('grows and shrinks with the drawing', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', { inputs: { points: [0, 0, 1, 0, 1, 1] } });
    expect(graph.schemaOf(node.id).inputs).toHaveLength(8);

    graph.setInput(node.id, 'points', [0, 0, 1, 0, 1, 1, 0, 1]);
    expect(graph.schemaOf(node.id).inputs).toHaveLength(10);
  });
});

describe('documents that carry grown dimensions', () => {
  it('reloads a profile whose dimension was overridden', () => {
    const graph = graphWith();
    const node = graph.addNode('sketch.polygon', {
      inputs: { points: [0, 0, 10, 0, 10, 5] },
    });
    graph.setInput(node.id, 'p2u', 25);

    const saved = graph.toJSON();
    const reopened = graphWith();
    expect(() => reopened.restore(saved)).not.toThrow();
    expect(reopened.inputValue(node.id, 'p2u')).toBe(25);
  });
});
