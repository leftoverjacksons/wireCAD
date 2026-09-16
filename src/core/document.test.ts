import { describe, expect, it } from 'vitest';
import { mathNodes } from '../nodes/math.js';
import { documentToText, parseDocument, serializeDocument } from './document.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  return { registry, graph: new Graph(registry) };
}

describe('document', () => {
  it('round-trips a graph through text', () => {
    const { registry, graph } = setup();
    const value = graph.addNode('math.number', {
      label: 'Wall',
      position: { x: 30, y: 60 },
      inputs: { value: 2.4 },
    });
    const double = graph.addNode('math.multiply', { inputs: { b: 2 } });
    graph.connect({ node: value.id, port: 'result' }, { node: double.id, port: 'a' });

    const restored = Graph.fromJSON(registry, parseDocument(documentToText(graph.toJSON())));

    expect(restored.toJSON()).toEqual(graph.toJSON());
    expect(restored.requireNode(value.id).label).toBe('Wall');
    expect(restored.requireNode(value.id).position).toEqual({ x: 30, y: 60 });
    expect(restored.inputValue(value.id, 'value')).toBe(2.4);
  });

  it('stamps the format and a save time', () => {
    const { graph } = setup();
    const document = serializeDocument(graph.toJSON());

    expect(document.format).toBe('wirecad');
    expect(document.version).toBe(1);
    expect(Number.isNaN(Date.parse(document.savedAt))).toBe(false);
  });

  it('rejects files that are not documents', () => {
    expect(() => parseDocument('not json at all')).toThrow(/valid JSON/);
    expect(() => parseDocument('[]')).toThrow(/not saved by wireCAD/);
    expect(() => parseDocument('{"format":"other","version":1}')).toThrow(/not saved by wireCAD/);
  });

  it('refuses a version it cannot faithfully load', () => {
    const payload = JSON.stringify({ format: 'wirecad', version: 99, graph: { nodes: [], edges: [] } });
    expect(() => parseDocument(payload)).toThrow(/version 99 is not supported/);
  });

  it('refuses a document whose graph is missing or malformed', () => {
    expect(() => parseDocument('{"format":"wirecad","version":1}')).toThrow(/missing its graph/);
    expect(() =>
      parseDocument('{"format":"wirecad","version":1,"graph":{"nodes":[]}}'),
    ).toThrow(/missing its graph/);
  });

  it('loads an empty document', () => {
    const { registry } = setup();
    const payload = JSON.stringify({
      format: 'wirecad',
      version: 1,
      savedAt: new Date().toISOString(),
      graph: { version: 1, nodes: [], edges: [] },
    });

    const restored = Graph.fromJSON(registry, parseDocument(payload));
    expect(restored.nodeCount).toBe(0);
  });
});
