import { describe, expect, it } from 'vitest';
import { planDisplay } from './display.js';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';
import type { NodeDefinition, NodeId } from './types.js';

const nodes: NodeDefinition[] = [
  {
    type: 'test.sketch',
    label: 'Sketch',
    category: 'Test',
    inputs: [],
    outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    evaluate: () => ({ profile: null }),
  },
  {
    type: 'test.extrude',
    label: 'Extrude',
    category: 'Test',
    inputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    type: 'test.fillet',
    label: 'Fillet',
    category: 'Test',
    inputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
    evaluate: () => ({ result: null }),
  },
  {
    // Shaped like the real extrude: it cuts a body with a profile.
    type: 'test.bore',
    label: 'Bore',
    category: 'Test',
    inputs: [
      { id: 'target', label: 'Target', type: 'geometry' },
      { id: 'profile', label: 'Profile', type: 'sketch' },
    ],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    // Reads a solid without standing in for it, like a face selector.
    type: 'test.reader',
    label: 'Reader',
    category: 'Test',
    inputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    outputs: [{ id: 'where', label: 'Where', type: 'plane' }],
    evaluate: () => ({ where: null }),
  },
];

function setup(): Graph {
  const registry = new NodeRegistry();
  registry.registerAll(nodes);
  return new Graph(registry);
}

/** Sketch → Block → Bore → Round, a chain of four. */
function chain(graph: Graph) {
  const sketch = graph.addNode('test.sketch', { label: 'Sketch' });
  const block = graph.addNode('test.extrude', { label: 'Block' });
  const bore = graph.addNode('test.fillet', { label: 'Bore' });
  const round = graph.addNode('test.fillet', { label: 'Round' });
  graph.connect({ node: sketch.id, port: 'profile' }, { node: block.id, port: 'profile' });
  graph.connect({ node: block.id, port: 'solid' }, { node: bore.id, port: 'solid' });
  graph.connect({ node: bore.id, port: 'result' }, { node: round.id, port: 'solid' });
  return { sketch: sketch.id, block: block.id, bore: bore.id, round: round.id };
}

const modes = (graph: Graph, options = {}): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [nodeId, shown] of planDisplay(graph, options)) {
    out[graph.requireNode(nodeId).label ?? nodeId] = shown.mode;
  }
  return out;
};

describe('what the model draws on its own', () => {
  it('shows the end of the chain and nothing before it', () => {
    const graph = setup();
    chain(graph);

    expect(modes(graph)).toEqual({ Round: 'model' });
  });

  it('keeps a body something only reads', () => {
    const graph = setup();
    const { round } = chain(graph);
    const reader = graph.addNode('test.reader', { label: 'Reader' });
    graph.connect({ node: round, port: 'result' }, { node: reader.id, port: 'solid' });

    // A face selector takes nothing away, so what it reads stays on screen.
    expect(modes(graph)).toEqual({ Round: 'model' });
  });

  it('obeys a node told to show or hide', () => {
    const graph = setup();
    const { block, round } = chain(graph);
    graph.setVisibility(block, true);
    graph.setVisibility(round, false);

    expect(modes(graph)).toEqual({ Block: 'model' });
  });
});

describe('rolling the view back to a node', () => {
  it('puts that node’s own result back on screen', () => {
    const graph = setup();
    const { block } = chain(graph);

    // Everything downstream of the block is absent, so nothing is standing in
    // for it any more.
    expect(modes(graph, { rolledBackTo: block }).Block).toBe('model');
  });

  it('outlines what is built on it, once', () => {
    const graph = setup();
    const { block } = chain(graph);

    // The cone is two nodes deep, but only its end is the model as it stands:
    // outlining both would draw the same body twice.
    expect(modes(graph, { rolledBackTo: block })).toEqual({ Block: 'model', Round: 'outline' });
  });

  it('leaves another branch alone', () => {
    const graph = setup();
    const { block } = chain(graph);
    const other = graph.addNode('test.sketch', { label: 'Elsewhere' });
    const apart = graph.addNode('test.extrude', { label: 'Apart' });
    graph.connect({ node: other.id, port: 'profile' }, { node: apart.id, port: 'profile' });

    // The state at a node is per-branch, not a suffix of one list.
    expect(modes(graph, { rolledBackTo: block })).toEqual({
      Block: 'model',
      Round: 'outline',
      Apart: 'model',
    });
  });

  it('is the ordinary view when rolled back to the end', () => {
    const graph = setup();
    const { round } = chain(graph);

    expect(modes(graph, { rolledBackTo: round })).toEqual(modes(graph));
  });

  it('draws the node it is looking at even when that node is hidden', () => {
    const graph = setup();
    const { block } = chain(graph);
    graph.setVisibility(block, false);

    // Hiding answers "is this in the way of the model". Rolling back to it is
    // asking to see that feature, which the flag has nothing to say about.
    expect(modes(graph, { rolledBackTo: block }).Block).toBe('model');
  });

  it('ignores a marker on a node that has gone', () => {
    const graph = setup();
    const { bore } = chain(graph);
    graph.removeNode(bore);

    expect(modes(graph, { rolledBackTo: bore })).toEqual({ Block: 'model', Round: 'model' });
  });

  it('leaves out what was only ever drawn for an absent feature', () => {
    const graph = setup();
    const outline = graph.addNode('test.sketch', { label: 'Outline' });
    const block = graph.addNode('test.extrude', { label: 'Block' });
    const circle = graph.addNode('test.sketch', { label: 'Bore profile' });
    const bore = graph.addNode('test.bore', { label: 'Bore' });
    graph.connect({ node: outline.id, port: 'profile' }, { node: block.id, port: 'profile' });
    graph.connect({ node: block.id, port: 'solid' }, { node: bore.id, port: 'target' });
    graph.connect({ node: circle.id, port: 'profile' }, { node: bore.id, port: 'profile' });

    // The circle is not downstream of the block — it is a branch of its own —
    // but it exists only for the bore. With the bore absent it would otherwise
    // reappear as a ring floating in space, nothing being left to read it.
    expect(modes(graph, { rolledBackTo: block.id })).toEqual({
      Block: 'model',
      Bore: 'outline',
    });
  });

  it('shows a profile again when what extruded it is absent', () => {
    const graph = setup();
    const { sketch } = chain(graph);

    expect(modes(graph, { rolledBackTo: sketch })).toEqual({
      Sketch: 'model',
      Round: 'outline',
    });
  });
});

describe('a node somebody asked to see', () => {
  it('is shown, and says it is only there because it was asked for', () => {
    const graph = setup();
    const { block } = chain(graph);

    const plan = planDisplay(graph, { pinned: new Set<NodeId>([block]) });
    expect(plan.get(block)?.mode).toBe('asked');
  });

  it('does not override being the model already', () => {
    const graph = setup();
    const { round } = chain(graph);

    const plan = planDisplay(graph, { pinned: new Set<NodeId>([round]) });
    expect(plan.get(round)?.mode).toBe('model');
  });
});
