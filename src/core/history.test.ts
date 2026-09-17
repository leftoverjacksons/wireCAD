import { describe, expect, it } from 'vitest';
import { mathNodes } from '../nodes/math.js';
import { Evaluator } from './evaluator.js';
import { Graph } from './graph.js';
import { History } from './history.js';
import { NodeRegistry } from './registry.js';

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  const graph = new Graph(registry);
  return { registry, graph, history: new History(graph) };
}

describe('History', () => {
  it('restores a changed literal', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', { inputs: { value: 5 } });

    history.capture();
    graph.setInput(node.id, 'value', 42);
    expect(graph.inputValue(node.id, 'value')).toBe(42);

    expect(history.undo()).toBe(true);
    expect(graph.inputValue(node.id, 'value')).toBe(5);
    expect(history.redo()).toBe(true);
    expect(graph.inputValue(node.id, 'value')).toBe(42);
  });

  it('restores a deleted node together with its wires', () => {
    const { graph, history } = setup();
    const source = graph.addNode('math.number', { inputs: { value: 3 } });
    const add = graph.addNode('math.add', { inputs: { b: 4 } });
    graph.connect({ node: source.id, port: 'result' }, { node: add.id, port: 'a' });

    history.capture();
    graph.removeNode(source.id);
    expect(graph.nodeCount).toBe(1);
    expect(graph.allEdges()).toHaveLength(0);

    history.undo();

    expect(graph.nodeCount).toBe(2);
    expect(graph.allEdges()).toHaveLength(1);
    expect(graph.incomingEdge(add.id, 'a')?.from.node).toBe(source.id);
    expect(graph.inputValue(source.id, 'value')).toBe(3);
  });

  it('restores a cut wire', () => {
    const { graph, history } = setup();
    const source = graph.addNode('math.number', { inputs: { value: 2 } });
    const add = graph.addNode('math.add');
    const edge = graph.connect({ node: source.id, port: 'result' }, { node: add.id, port: 'a' });

    history.capture();
    graph.disconnect(edge.id);
    expect(graph.allEdges()).toHaveLength(0);

    history.undo();

    expect(graph.allEdges()).toHaveLength(1);
    expect(graph.incomingEdge(add.id, 'a')).toBeDefined();
  });

  it('emits one document-replaced change per undo', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', { inputs: { value: 1 } });

    history.capture();
    graph.setInput(node.id, 'value', 9);

    const changes: string[] = [];
    graph.subscribe((change) => changes.push(change.kind));
    history.undo();

    expect(changes).toEqual(['document-replaced']);
  });

  it('reports what it can do and drops redo once a new edit lands', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', { inputs: { value: 1 } });

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);

    history.capture();
    graph.setInput(node.id, 'value', 2);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(history.canRedo).toBe(true);

    history.capture();
    graph.setInput(node.id, 'value', 7);
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toBe(true);
    expect(graph.inputValue(node.id, 'value')).toBe(1);
  });

  it('does nothing when there is no history', () => {
    const { history } = setup();
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(false);
  });

  it('preserves node positions and labels', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', {
      position: { x: 40, y: 90 },
      label: 'Thickness',
    });

    history.capture();
    graph.setPosition(node.id, { x: 500, y: 500 });
    history.undo();

    expect(graph.requireNode(node.id).position).toEqual({ x: 40, y: 90 });
    expect(graph.requireNode(node.id).label).toBe('Thickness');
  });

  it('returns to a cached solve, so undo recomputes nothing', () => {
    const { registry, graph, history } = setup();
    const evaluator = new Evaluator(registry);
    const width = graph.addNode('math.number', { inputs: { value: 4 } });
    const area = graph.addNode('math.multiply', { inputs: { b: 3 } });
    graph.connect({ node: width.id, port: 'result' }, { node: area.id, port: 'a' });

    evaluator.evaluate(graph);

    history.capture();
    graph.setInput(width.id, 'value', 10);
    evaluator.evaluate(graph);

    history.undo();
    const restored = evaluator.evaluate(graph);

    expect(restored.stats.evaluated).toBe(0);
    expect(restored.stats.cached).toBe(2);
    expect(restored.results.get(area.id)?.outputs.result).toBe(12);
  });

  it('forgets a capture whose change was taken back by hand', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', { inputs: { value: 5 } });

    // A preview: captured, put in the graph, then removed again on Cancel.
    history.capture();
    const preview = graph.addNode('math.number', { inputs: { value: 9 } });
    graph.removeNode(preview.id);
    history.forget();

    expect(history.canUndo).toBe(false);
    expect(graph.getNode(node.id)?.inputs.value).toBe(5);
  });

  it('gives back the redo that the forgotten capture discarded', () => {
    const { graph, history } = setup();
    const node = graph.addNode('math.number', { inputs: { value: 5 } });

    history.capture();
    graph.setInput(node.id, 'value', 12);
    history.undo();
    expect(history.canRedo).toBe(true);

    // Opening a dialog and cancelling it must not cost the redo.
    history.capture();
    const preview = graph.addNode('math.number', { inputs: { value: 9 } });
    graph.removeNode(preview.id);
    history.forget();

    expect(history.canRedo).toBe(true);
    history.redo();
    expect(graph.getNode(node.id)?.inputs.value).toBe(12);
  });
});
