import { describe, expect, it } from 'vitest';
import { Evaluator } from './evaluator.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';
import type { NodeDefinition } from './types.js';

/**
 * A suppressed feature does not happen, and the model goes on without it.
 *
 * The stand-ins carry numbers rather than shapes, because what is being checked
 * is which value came out the other end, not what the kernel did with it.
 */
const nodes: NodeDefinition[] = [
  {
    type: 'test.block',
    label: 'Block',
    category: 'Test',
    inputs: [{ id: 'size', label: 'Size', type: 'number', default: 10 }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    // A number standing in for a shape: a value the next node can be seen to
    // have received, which is the whole question here.
    evaluate: (inputs) => ({ solid: Number(inputs.size) }),
  },
  {
    type: 'test.fillet',
    label: 'Fillet',
    category: 'Test',
    inputs: [
      { id: 'solid', label: 'Solid', type: 'geometry' },
      { id: 'radius', label: 'Radius', type: 'number', default: 2 },
    ],
    outputs: [
      { id: 'result', label: 'Result', type: 'geometry' },
      { id: 'radius', label: 'Radius', type: 'number', echoes: 'radius' },
    ],
    evaluate: (inputs) => ({ result: Number(inputs.solid) + Number(inputs.radius) }),
  },
  {
    type: 'test.extrude',
    label: 'Extrude',
    category: 'Test',
    inputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: 1 }),
  },
  {
    type: 'test.sketch',
    label: 'Sketch',
    category: 'Test',
    inputs: [],
    outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    evaluate: () => ({ profile: 0 }),
  },
];

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(nodes);
  return { graph: new Graph(registry), evaluator: new Evaluator(registry) };
}

/** Block → Fillet → Fillet, so there is something downstream to look at. */
function chain(graph: Graph) {
  const block = graph.addNode('test.block', { inputs: { size: 10 } });
  const fillet = graph.addNode('test.fillet', { inputs: { radius: 3 } });
  const later = graph.addNode('test.fillet', { inputs: { radius: 5 } });
  graph.connect({ node: block.id, port: 'solid' }, { node: fillet.id, port: 'solid' });
  graph.connect({ node: fillet.id, port: 'result' }, { node: later.id, port: 'solid' });
  return { block: block.id, fillet: fillet.id, later: later.id };
}

describe('a suppressed node', () => {
  it('hands its input on untouched', () => {
    const { graph, evaluator } = setup();
    const { fillet, later } = chain(graph);

    expect(evaluator.evaluate(graph).results.get(later)?.outputs.result).toBe(18);

    graph.setSuppressed(fillet, true);
    const result = evaluator.evaluate(graph);

    expect(result.results.get(fillet)?.status).toBe('suppressed');
    expect(result.results.get(fillet)?.outputs.result).toBe(10);
    // The later fillet still rounds — on the block, as if the first never was.
    expect(result.results.get(later)?.outputs.result).toBe(15);
    expect(result.stats.suppressed).toBe(1);
  });

  it('goes on publishing the dimensions it holds', () => {
    const { graph, evaluator } = setup();
    const { fillet } = chain(graph);
    graph.setSuppressed(fillet, true);

    // A held-back fillet still says what radius it would round at, so anything
    // reading that number goes on reading it.
    expect(evaluator.evaluate(graph).results.get(fillet)?.outputs.radius).toBe(3);
  });

  it('acts again when it is let go', () => {
    const { graph, evaluator } = setup();
    const { fillet, later } = chain(graph);

    graph.setSuppressed(fillet, true);
    evaluator.evaluate(graph);
    graph.setSuppressed(fillet, false);

    expect(evaluator.evaluate(graph).results.get(later)?.outputs.result).toBe(18);
    expect(graph.requireNode(fillet).suppressed).toBeUndefined();
  });

  it('is a different result from the same node acting', () => {
    const { graph, evaluator } = setup();
    const { fillet } = chain(graph);

    const acting = evaluator.evaluate(graph).results.get(fillet)?.hash;
    graph.setSuppressed(fillet, true);
    const held = evaluator.evaluate(graph).results.get(fillet)?.hash;

    // Downstream hashes are built from this one, so a shared hash would serve
    // the rounded body from the cache for the model without the rounding.
    expect(held).not.toBe(acting);
  });

  it('stops the chain where nothing can pass through it', () => {
    const { graph, evaluator } = setup();
    const sketch = graph.addNode('test.sketch');
    const extrude = graph.addNode('test.extrude');
    const fillet = graph.addNode('test.fillet');
    graph.connect({ node: sketch.id, port: 'profile' }, { node: extrude.id, port: 'profile' });
    graph.connect({ node: extrude.id, port: 'solid' }, { node: fillet.id, port: 'solid' });

    // A profile is no substitute for the solid an extrude makes, so holding the
    // extrude back leaves nothing for the fillet to round.
    graph.setSuppressed(extrude.id, true);
    const result = evaluator.evaluate(graph);

    expect(result.results.get(extrude.id)?.status).toBe('skipped');
    expect(result.results.get(fillet.id)?.status).toBe('skipped');
  });

  it('is part of the document, so it saves and reloads', () => {
    const { graph } = setup();
    const { fillet } = chain(graph);
    graph.setSuppressed(fillet, true);

    const reloaded = JSON.parse(JSON.stringify(graph.toJSON()));
    graph.restore(reloaded);

    expect(graph.requireNode(fillet).suppressed).toBe(true);
  });
});
