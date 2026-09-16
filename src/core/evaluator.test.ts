import { describe, expect, it } from 'vitest';
import { mathNodes } from '../nodes/math.js';
import { Evaluator } from './evaluator.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  return { registry, graph: new Graph(registry), evaluator: new Evaluator(registry) };
}

describe('Evaluator', () => {
  it('evaluates a wired chain', () => {
    const { graph, evaluator } = setup();
    const width = graph.addNode('math.number', { inputs: { value: 4 } });
    const height = graph.addNode('math.number', { inputs: { value: 5 } });
    const area = graph.addNode('math.multiply');
    graph.connect({ node: width.id, port: 'result' }, { node: area.id, port: 'a' });
    graph.connect({ node: height.id, port: 'result' }, { node: area.id, port: 'b' });

    const result = evaluator.evaluate(graph);

    expect(result.results.get(area.id)?.outputs.result).toBe(20);
    expect(result.stats.evaluated).toBe(3);
    expect(result.stats.cached).toBe(0);
  });

  it('falls back to declared port defaults for unwired inputs', () => {
    const { graph, evaluator } = setup();
    const series = graph.addNode('math.series', { inputs: { count: 4 } });

    const result = evaluator.evaluate(graph);

    expect(result.results.get(series.id)?.outputs.result).toEqual([0, 1, 2, 3]);
  });

  it('re-evaluates only the downstream cone of a changed input', () => {
    const { graph, evaluator } = setup();
    const width = graph.addNode('math.number', { inputs: { value: 4 } });
    const height = graph.addNode('math.number', { inputs: { value: 5 } });
    const area = graph.addNode('math.multiply');
    graph.connect({ node: width.id, port: 'result' }, { node: area.id, port: 'a' });
    graph.connect({ node: height.id, port: 'result' }, { node: area.id, port: 'b' });

    const unrelatedSeries = graph.addNode('math.series', { inputs: { count: 3 } });
    const unrelatedSum = graph.addNode('math.sum');
    graph.connect(
      { node: unrelatedSeries.id, port: 'result' },
      { node: unrelatedSum.id, port: 'values' },
    );

    const first = evaluator.evaluate(graph);
    expect(first.stats.evaluated).toBe(5);

    graph.setInput(width.id, 'value', 10);
    const second = evaluator.evaluate(graph);

    expect(second.results.get(area.id)?.outputs.result).toBe(50);
    expect(second.stats.evaluated).toBe(2);
    expect(second.stats.cached).toBe(3);
    expect(second.results.get(unrelatedSum.id)?.status).toBe('cached');
    expect(second.results.get(height.id)?.status).toBe('cached');
  });

  it('performs no work when nothing changed', () => {
    const { graph, evaluator } = setup();
    const value = graph.addNode('math.number', { inputs: { value: 7 } });
    const double = graph.addNode('math.multiply', { inputs: { b: 2 } });
    graph.connect({ node: value.id, port: 'result' }, { node: double.id, port: 'a' });

    evaluator.evaluate(graph);
    const second = evaluator.evaluate(graph);

    expect(second.stats.evaluated).toBe(0);
    expect(second.stats.cached).toBe(2);
    expect(second.results.get(double.id)?.outputs.result).toBe(14);
  });

  it('shares cache entries between structurally identical subgraphs', () => {
    const { graph, evaluator } = setup();
    for (let i = 0; i < 2; i++) {
      const a = graph.addNode('math.number', { inputs: { value: 2 } });
      const b = graph.addNode('math.number', { inputs: { value: 3 } });
      const sum = graph.addNode('math.add');
      graph.connect({ node: a.id, port: 'result' }, { node: sum.id, port: 'a' });
      graph.connect({ node: b.id, port: 'result' }, { node: sum.id, port: 'b' });
    }

    const result = evaluator.evaluate(graph);

    expect(result.stats.evaluated).toBe(3);
    expect(result.stats.cached).toBe(3);
  });

  it('distinguishes operands wired to different input ports', () => {
    const { graph, evaluator } = setup();
    const a = graph.addNode('math.number', { inputs: { value: 10 } });
    const b = graph.addNode('math.number', { inputs: { value: 3 } });
    const forward = graph.addNode('math.subtract');
    const reversed = graph.addNode('math.subtract');
    graph.connect({ node: a.id, port: 'result' }, { node: forward.id, port: 'a' });
    graph.connect({ node: b.id, port: 'result' }, { node: forward.id, port: 'b' });
    graph.connect({ node: b.id, port: 'result' }, { node: reversed.id, port: 'a' });
    graph.connect({ node: a.id, port: 'result' }, { node: reversed.id, port: 'b' });

    const result = evaluator.evaluate(graph);

    expect(result.results.get(forward.id)?.outputs.result).toBe(7);
    expect(result.results.get(reversed.id)?.outputs.result).toBe(-7);
  });

  it('contains a node failure without aborting the solve', () => {
    const { graph, evaluator } = setup();
    const numerator = graph.addNode('math.number', { inputs: { value: 1 } });
    const divide = graph.addNode('math.divide', { inputs: { b: 0 } });
    const downstream = graph.addNode('math.multiply', { inputs: { b: 2 } });
    graph.connect({ node: numerator.id, port: 'result' }, { node: divide.id, port: 'a' });
    graph.connect({ node: divide.id, port: 'result' }, { node: downstream.id, port: 'a' });

    const independent = graph.addNode('math.number', { inputs: { value: 99 } });

    const result = evaluator.evaluate(graph);

    expect(result.results.get(divide.id)?.status).toBe('error');
    expect(result.results.get(divide.id)?.error).toBe('Division by zero');
    expect(result.results.get(downstream.id)?.status).toBe('skipped');
    expect(result.results.get(independent.id)?.status).toBe('evaluated');
    expect(result.results.get(independent.id)?.outputs.result).toBe(99);
  });

  it('caches failures so a known-bad node is not recomputed', () => {
    const { graph, evaluator } = setup();
    const divide = graph.addNode('math.divide', { inputs: { a: 1, b: 0 } });

    evaluator.evaluate(graph);
    const hitsBefore = evaluator.cache.stats.hits;
    const second = evaluator.evaluate(graph);

    expect(evaluator.cache.stats.hits).toBe(hitsBefore + 1);
    expect(second.results.get(divide.id)?.error).toBe('Division by zero');
  });

  it('recovers once the failing input is corrected', () => {
    const { graph, evaluator } = setup();
    const divide = graph.addNode('math.divide', { inputs: { a: 10, b: 0 } });

    expect(evaluator.evaluate(graph).results.get(divide.id)?.status).toBe('error');
    graph.setInput(divide.id, 'b', 2);
    const recovered = evaluator.evaluate(graph);

    expect(recovered.results.get(divide.id)?.status).toBe('evaluated');
    expect(recovered.results.get(divide.id)?.outputs.result).toBe(5);
  });

  it('treats a literal list input as part of the cache key', () => {
    const { graph, evaluator } = setup();
    const sum = graph.addNode('math.sum', { inputs: { values: [1, 2, 3] } });

    expect(evaluator.evaluate(graph).results.get(sum.id)?.outputs.result).toBe(6);

    graph.setInput(sum.id, 'values', [1, 2, 4]);
    const second = evaluator.evaluate(graph);

    expect(second.stats.evaluated).toBe(1);
    expect(second.results.get(sum.id)?.outputs.result).toBe(7);
  });

  it('does not invalidate cached results when a node is moved or renamed', () => {
    const { graph, evaluator } = setup();
    const value = graph.addNode('math.number', { inputs: { value: 3 } });

    evaluator.evaluate(graph);
    graph.setPosition(value.id, { x: 250, y: 90 });
    graph.setLabel(value.id, 'Wall thickness');
    const second = evaluator.evaluate(graph);

    expect(second.stats.evaluated).toBe(0);
    expect(second.stats.cached).toBe(1);
  });
});
