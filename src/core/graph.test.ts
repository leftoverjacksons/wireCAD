import { describe, expect, it } from 'vitest';
import { mathNodes } from '../nodes/math.js';
import { Graph, affectsEvaluation } from './graph.js';
import { NodeRegistry } from './registry.js';

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  return { registry, graph: new Graph(registry) };
}

describe('Graph', () => {
  it('rejects a connection that would create a cycle', () => {
    const { graph } = setup();
    const a = graph.addNode('math.add');
    const b = graph.addNode('math.add');
    graph.connect({ node: a.id, port: 'result' }, { node: b.id, port: 'a' });

    expect(() => graph.connect({ node: b.id, port: 'result' }, { node: a.id, port: 'a' })).toThrow(
      /cycle/,
    );
  });

  it('rejects self-connection', () => {
    const { graph } = setup();
    const a = graph.addNode('math.add');

    expect(() => graph.connect({ node: a.id, port: 'result' }, { node: a.id, port: 'a' })).toThrow(
      /cycle/,
    );
  });

  it('rejects incompatible port types', () => {
    const { graph } = setup();
    const series = graph.addNode('math.series');
    const add = graph.addNode('math.add');

    expect(() =>
      graph.connect({ node: series.id, port: 'result' }, { node: add.id, port: 'a' }),
    ).toThrow(/Cannot connect list to number/);
  });

  it('rejects a second wire into an occupied input port', () => {
    const { graph } = setup();
    const a = graph.addNode('math.number');
    const b = graph.addNode('math.number');
    const add = graph.addNode('math.add');
    graph.connect({ node: a.id, port: 'result' }, { node: add.id, port: 'a' });

    expect(() => graph.connect({ node: b.id, port: 'result' }, { node: add.id, port: 'a' })).toThrow(
      /already connected/,
    );
  });

  it('rejects unknown ports and node types', () => {
    const { graph } = setup();
    const add = graph.addNode('math.add');

    expect(() => graph.addNode('math.nonexistent')).toThrow(/Unknown node type/);
    expect(() => graph.setInput(add.id, 'nope', 1)).toThrow(/no input port/);
  });

  it('removes incident edges when a node is removed', () => {
    const { graph } = setup();
    const a = graph.addNode('math.number');
    const add = graph.addNode('math.add');
    graph.connect({ node: a.id, port: 'result' }, { node: add.id, port: 'a' });

    graph.removeNode(a.id);

    expect(graph.allEdges()).toHaveLength(0);
    expect(graph.incomingEdges(add.id)).toHaveLength(0);
  });

  it('reports the full downstream cone of a node', () => {
    const { graph } = setup();
    const root = graph.addNode('math.number');
    const mid = graph.addNode('math.add');
    const leaf = graph.addNode('math.multiply');
    const unrelated = graph.addNode('math.number');
    graph.connect({ node: root.id, port: 'result' }, { node: mid.id, port: 'a' });
    graph.connect({ node: mid.id, port: 'result' }, { node: leaf.id, port: 'a' });

    expect(graph.downstreamOf(root.id)).toEqual(new Set([mid.id, leaf.id]));
    expect(graph.downstreamOf(unrelated.id).size).toBe(0);
  });

  it('orders nodes so every producer precedes its consumers', () => {
    const { graph } = setup();
    const leaf = graph.addNode('math.multiply');
    const mid = graph.addNode('math.add');
    const root = graph.addNode('math.number');
    graph.connect({ node: root.id, port: 'result' }, { node: mid.id, port: 'a' });
    graph.connect({ node: mid.id, port: 'result' }, { node: leaf.id, port: 'a' });

    const order = graph.topologicalOrder();

    expect(order.indexOf(root.id)).toBeLessThan(order.indexOf(mid.id));
    expect(order.indexOf(mid.id)).toBeLessThan(order.indexOf(leaf.id));
  });

  it('round-trips through serialization', () => {
    const { registry, graph } = setup();
    const a = graph.addNode('math.number', { inputs: { value: 12 }, position: { x: 10, y: 20 } });
    const add = graph.addNode('math.add', { inputs: { b: 5 }, label: 'Offset' });
    graph.connect({ node: a.id, port: 'result' }, { node: add.id, port: 'a' });

    const restored = Graph.fromJSON(registry, JSON.parse(JSON.stringify(graph.toJSON())));

    expect(restored.toJSON()).toEqual(graph.toJSON());
    expect(restored.inputValue(add.id, 'b')).toBe(5);
    expect(restored.getNode(add.id)?.label).toBe('Offset');
  });

  it('allocates fresh ids that do not collide with restored ones', () => {
    const { registry, graph } = setup();
    graph.addNode('math.number');
    graph.addNode('math.number');
    const restored = Graph.fromJSON(registry, graph.toJSON());

    const added = restored.addNode('math.number');

    expect(restored.allNodes().filter((n) => n.id === added.id)).toHaveLength(1);
  });

  it('notifies subscribers and distinguishes presentation-only changes', () => {
    const { graph } = setup();
    const changes: string[] = [];
    const unsubscribe = graph.subscribe((change) => {
      if (affectsEvaluation(change)) changes.push(change.kind);
    });

    const node = graph.addNode('math.number');
    graph.setInput(node.id, 'value', 3);
    graph.setPosition(node.id, { x: 1, y: 1 });
    graph.setLabel(node.id, 'Thickness');
    unsubscribe();
    graph.setInput(node.id, 'value', 4);

    expect(changes).toEqual(['node-added', 'input-changed']);
  });
});
