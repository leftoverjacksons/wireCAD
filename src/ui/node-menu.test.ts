import { describe, expect, it } from 'vitest';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import type { NodeDefinition, NodeId } from '../core/types.js';
import { deleteOutcome, nodeMenu } from './node-menu.js';
import type { NodeMenuAction, NodeMenuItem } from './node-menu.js';

/** Shaped like the real thing: what matters here is the ports. */
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
    // A sketch goes in and a solid comes out, so nothing passes through.
    type: 'test.extrude',
    label: 'Extrude',
    category: 'Test',
    inputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
    outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
    evaluate: () => ({ solid: null }),
  },
  {
    // A solid goes in and a solid comes out, so a solid passes through.
    type: 'test.fillet',
    label: 'Fillet',
    category: 'Test',
    inputs: [
      { id: 'solid', label: 'Solid', type: 'geometry' },
      { id: 'radius', label: 'Radius', type: 'number', default: 2 },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
    evaluate: () => ({ result: null }),
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
  {
    type: 'test.number',
    label: 'Number',
    category: 'Test',
    inputs: [{ id: 'value', label: 'Value', type: 'number', default: 1 }],
    outputs: [{ id: 'value', label: 'Value', type: 'number' }],
    evaluate: (inputs) => ({ value: inputs.value ?? 0 }),
  },
];

function setup(): Graph {
  const registry = new NodeRegistry();
  registry.registerAll(nodes);
  return new Graph(registry);
}

/** Sketch → Extrude (Block) → Fillet, with a reader hanging off the fillet. */
function chain(graph: Graph) {
  const sketch = graph.addNode('test.sketch');
  const block = graph.addNode('test.extrude', { label: 'Block' });
  const fillet = graph.addNode('test.fillet');
  const reader = graph.addNode('test.reader');
  graph.connect({ node: sketch.id, port: 'profile' }, { node: block.id, port: 'profile' });
  graph.connect({ node: block.id, port: 'solid' }, { node: fillet.id, port: 'solid' });
  graph.connect({ node: fillet.id, port: 'result' }, { node: reader.id, port: 'solid' });
  return { sketch: sketch.id, block: block.id, fillet: fillet.id, reader: reader.id };
}

const OPEN = { editable: false, shown: true };

function menuFor(graph: Graph, nodeId: NodeId, state = OPEN): Map<NodeMenuAction, NodeMenuItem> {
  return new Map(nodeMenu(graph, nodeId, state).map((item) => [item.action, item]));
}

describe('what deleting a node would cost', () => {
  it('says what takes its place when something can', () => {
    const graph = setup();
    const { fillet } = chain(graph);

    expect(deleteOutcome(graph, fillet)).toEqual({ healed: 1, stranded: 0, into: 'Block' });
    expect(menuFor(graph, fillet).get('delete')?.detail).toBe('1 node reads Block instead');
  });

  it('says what is left wanting when nothing can', () => {
    const graph = setup();
    const { block } = chain(graph);

    // An extrude hands on a solid it made from a sketch, and a sketch is no
    // substitute for a solid, so the fillet is left without an input.
    expect(deleteOutcome(graph, block)).toEqual({ healed: 0, stranded: 1, into: null });
    expect(menuFor(graph, block).get('delete')?.detail).toBe('1 node left without an input');
  });

  it('says nothing about a node at the end of a chain', () => {
    const graph = setup();
    const { reader } = chain(graph);

    expect(menuFor(graph, reader).get('delete')?.detail).toBeUndefined();
  });

  it('is what removing the node actually does', async () => {
    const graph = setup();
    const { fillet } = chain(graph);
    const { removeAndHeal } = await import('../core/rewire.js');

    const predicted = deleteOutcome(graph, fillet);
    const actual = removeAndHeal(graph, fillet);

    expect({ healed: actual.healed, stranded: actual.stranded }).toEqual({
      healed: predicted.healed,
      stranded: predicted.stranded,
    });
  });
});

describe('deleting a branch', () => {
  it('is offered with a count when there is a branch to take', () => {
    const graph = setup();
    const { block } = chain(graph);

    expect(menuFor(graph, block).get('delete-branch')?.detail).toBe('2 nodes after it go too');
  });

  it('is not offered when only the node itself would go', () => {
    const graph = setup();
    const { reader } = chain(graph);

    expect(menuFor(graph, reader).has('delete-branch')).toBe(false);
  });
});

describe('suppressing a feature', () => {
  it('is offered where something passes through, and says what', () => {
    const graph = setup();
    const { fillet } = chain(graph);

    const suppress = menuFor(graph, fillet).get('suppress');
    expect(suppress?.refusal).toBeUndefined();
    expect(suppress?.detail).toBe('hands its Body on untouched');
  });

  it('says why not where nothing does', () => {
    const graph = setup();
    const { block } = chain(graph);

    expect(menuFor(graph, block).get('suppress')?.refusal).toBe(
      'Nothing passes through this node',
    );
  });

  it('turns into its own undoing once the node is suppressed', () => {
    const graph = setup();
    const { fillet } = chain(graph);
    graph.setSuppressed(fillet, true);

    const menu = menuFor(graph, fillet);
    expect(menu.has('suppress')).toBe(false);
    expect(menu.has('unsuppress')).toBe(true);
  });
});

describe('showing and hiding', () => {
  it('offers the opposite of what is on screen', () => {
    const graph = setup();
    const { fillet } = chain(graph);

    expect(menuFor(graph, fillet, { editable: false, shown: true }).has('hide')).toBe(true);
    expect(menuFor(graph, fillet, { editable: false, shown: false }).has('show')).toBe(true);
  });

  it('follows the setting rather than the screen once one is pinned', () => {
    const graph = setup();
    const { fillet } = chain(graph);
    graph.setVisibility(fillet, false);

    // A hidden node is still drawn while it is selected, as a ghost of what it
    // made. The entry is about the setting, so it offers to undo the setting.
    expect(menuFor(graph, fillet, { editable: false, shown: true }).has('show')).toBe(true);
  });

  it('refuses for a node with nothing to draw', () => {
    const graph = setup();
    const number = graph.addNode('test.number');

    expect(menuFor(graph, number.id).get('hide')?.refusal).toBe(
      'This node makes nothing to draw',
    );
  });

  it('offers the automatic rule back once the answer has been pinned', () => {
    const graph = setup();
    const { fillet } = chain(graph);

    expect(menuFor(graph, fillet).has('auto')).toBe(false);
    graph.setVisibility(fillet, false);
    expect(menuFor(graph, fillet, { editable: false, shown: false }).has('auto')).toBe(true);
  });
});

describe('editing', () => {
  it('says so rather than disappearing when nothing reopens', () => {
    const graph = setup();
    const { fillet } = chain(graph);

    expect(menuFor(graph, fillet).get('edit')?.refusal).toBe('Nothing here reopens for editing');
    expect(menuFor(graph, fillet, { editable: true, shown: true }).get('edit')?.refusal)
      .toBeUndefined();
  });
});
