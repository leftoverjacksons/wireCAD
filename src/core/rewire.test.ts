import { describe, expect, it } from 'vitest';
import { Graph } from './graph.js';
import { NodeRegistry } from './registry.js';
import { branchOf, passThroughOf, removeAndHeal, spliceAfter } from './rewire.js';
import type { NodeDefinition } from './types.js';

/** Stand-ins shaped like the real thing: what matters here is the ports. */
const nodes: NodeDefinition[] = [
  {
    type: 'test.block',
    label: 'Block',
    category: 'Test',
    inputs: [{ id: 'size', label: 'Size', type: 'number', default: 10 }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    // A fillet: a solid goes in and a solid comes out, so a solid passes through.
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
    evaluate: () => ({ result: null }),
  },
  {
    // An extrude: a sketch goes in and a solid comes out, so nothing passes through.
    type: 'test.extrude',
    label: 'Extrude',
    category: 'Test',
    inputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    type: 'test.sketch',
    label: 'Sketch',
    category: 'Test',
    inputs: [],
    outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    evaluate: () => ({ profile: null }),
  },
  {
    // A cut names what it works on before what it works with.
    type: 'test.cut',
    label: 'Cut',
    category: 'Test',
    inputs: [
      { id: 'target', label: 'Target', type: 'geometry' },
      { id: 'tool', label: 'Tool', type: 'geometry' },
    ],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    // Reads a solid without replacing it, like a face selector.
    type: 'test.reader',
    label: 'Reader',
    category: 'Test',
    inputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    outputs: [{ id: 'where', label: 'Where', type: 'plane' }],
    evaluate: () => ({ where: null }),
  },
];

function setup() {
  const registry = new NodeRegistry();
  registry.registerAll(nodes);
  return new Graph(registry);
}

/** Block → Fillet, with a reader hanging off the fillet. */
function chain(graph: Graph) {
  const block = graph.addNode('test.block');
  const fillet = graph.addNode('test.fillet');
  const reader = graph.addNode('test.reader');
  graph.connect({ node: block.id, port: 'solid' }, { node: fillet.id, port: 'solid' });
  graph.connect({ node: fillet.id, port: 'result' }, { node: reader.id, port: 'solid' });
  return { block: block.id, fillet: fillet.id, reader: reader.id };
}

describe('passThroughOf', () => {
  it('finds the way through a node that modifies what it is given', () => {
    const graph = setup();
    const fillet = graph.addNode('test.fillet');
    expect(passThroughOf(graph, fillet.id)).toEqual({
      input: 'solid',
      output: 'result',
      type: 'geometry',
    });
  });

  it('finds none through a node that turns one thing into another', () => {
    const graph = setup();
    const extrude = graph.addNode('test.extrude');
    expect(passThroughOf(graph, extrude.id)).toBeNull();
  });

  it('takes what a feature works on, not what it works with', () => {
    const graph = setup();
    const cut = graph.addNode('test.cut');
    expect(passThroughOf(graph, cut.id)?.input).toBe('target');
  });
});

describe('spliceAfter', () => {
  it('appends at the end of a chain, where nothing is reading yet', () => {
    const graph = setup();
    const block = graph.addNode('test.block');
    const fillet = graph.addNode('test.fillet');

    const result = spliceAfter(graph, block.id, fillet.id);

    expect(result.moved).toBe(0);
    expect(graph.incomingEdge(fillet.id, 'solid')?.from.node).toBe(block.id);
  });

  it('takes the consumers with it in the middle of a chain', () => {
    const graph = setup();
    const { block, fillet, reader } = chain(graph);
    const move = graph.addNode('test.fillet', { label: 'Move' });

    const result = spliceAfter(graph, block, move.id);

    expect(result.moved).toBe(1);
    // Block feeds the new node, the new node feeds what the block used to.
    expect(graph.incomingEdge(move.id, 'solid')?.from.node).toBe(block);
    expect(graph.incomingEdge(fillet, 'solid')?.from.node).toBe(move.id);
    // And what hung off the fillet is untouched by any of it.
    expect(graph.incomingEdge(reader, 'solid')?.from.node).toBe(fillet);
  });

  it('refuses a node with nothing passing through it', () => {
    const graph = setup();
    const block = graph.addNode('test.block');
    const extrude = graph.addNode('test.extrude');

    expect(() => spliceAfter(graph, block.id, extrude.id)).toThrow(/pass anything through/);
  });

  it('refuses when the node being spliced in is already wired up', () => {
    const graph = setup();
    const { block, fillet } = chain(graph);

    expect(() => spliceAfter(graph, block, fillet)).toThrow(/already has something wired/);
  });

  it('leaves the graph alone when it refuses', () => {
    const graph = setup();
    const { block, fillet } = chain(graph);
    const before = JSON.stringify(graph.toJSON());

    // Backwards: the fillet is downstream of the block, so this is a cycle.
    expect(() => spliceAfter(graph, fillet, block)).toThrow();
    expect(JSON.stringify(graph.toJSON())).toBe(before);
  });
});

describe('removeAndHeal', () => {
  it('joins what a removed node was reading to what was reading it', () => {
    const graph = setup();
    const { block, fillet, reader } = chain(graph);

    const result = removeAndHeal(graph, fillet);

    expect(result).toEqual({ healed: 1, stranded: 0 });
    expect(graph.getNode(fillet)).toBeUndefined();
    expect(graph.incomingEdge(reader, 'solid')?.from.node).toBe(block);
  });

  it('strands what it cannot stand in for', () => {
    const graph = setup();
    const sketch = graph.addNode('test.sketch');
    const extrude = graph.addNode('test.extrude');
    const fillet = graph.addNode('test.fillet');
    graph.connect({ node: sketch.id, port: 'profile' }, { node: extrude.id, port: 'profile' });
    graph.connect({ node: extrude.id, port: 'solid' }, { node: fillet.id, port: 'solid' });

    // A sketch is no substitute for a solid, so the fillet is left wanting one.
    const result = removeAndHeal(graph, extrude.id);

    expect(result).toEqual({ healed: 0, stranded: 1 });
    expect(graph.incomingEdge(fillet.id, 'solid')).toBeUndefined();
    expect(graph.getNode(fillet.id)).toBeDefined();
  });

  it('is a plain removal at the end of a chain', () => {
    const graph = setup();
    const { fillet } = chain(graph);
    graph.removeNode(graph.allNodes().find((node) => node.type === 'test.reader')!.id);

    expect(removeAndHeal(graph, fillet)).toEqual({ healed: 0, stranded: 0 });
    expect(graph.getNode(fillet)).toBeUndefined();
  });

  it('strands a consumer when the removed node was reading nothing', () => {
    const graph = setup();
    const fillet = graph.addNode('test.fillet');
    const reader = graph.addNode('test.reader');
    graph.connect({ node: fillet.id, port: 'result' }, { node: reader.id, port: 'solid' });

    expect(removeAndHeal(graph, fillet.id)).toEqual({ healed: 0, stranded: 1 });
    expect(graph.incomingEdge(reader.id, 'solid')).toBeUndefined();
  });
});

describe('branchOf', () => {
  it('counts a node and everything that would have nothing left to read', () => {
    const graph = setup();
    const { block, fillet, reader } = chain(graph);

    expect(branchOf(graph, block)).toEqual(new Set([block, fillet, reader]));
    expect(branchOf(graph, fillet)).toEqual(new Set([fillet, reader]));
    expect(branchOf(graph, reader)).toEqual(new Set([reader]));
  });

  it('spares a node that something else still feeds', () => {
    const graph = setup();
    const first = graph.addNode('test.block');
    const second = graph.addNode('test.block');
    const cut = graph.addNode('test.cut');
    graph.connect({ node: first.id, port: 'solid' }, { node: cut.id, port: 'target' });
    graph.connect({ node: second.id, port: 'solid' }, { node: cut.id, port: 'tool' });

    // The cut still has a tool, so it is not carried off with the target.
    expect(branchOf(graph, first.id)).toEqual(new Set([first.id]));
  });
});
