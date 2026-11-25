import { describe, expect, it } from 'vitest';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import type { NodeSchema } from '../core/types.js';
import { NODE_WIDTH, ROW_GAP, nodeHeight } from './metrics.js';
import { planLayout } from './layout.js';

const solid = (type: string): NodeSchema => ({
  type,
  label: type,
  category: 'Test',
  inputs: [{ id: 'in', label: 'In', type: 'geometry' }],
  outputs: [{ id: 'out', label: 'Out', type: 'geometry' }],
});
const source: NodeSchema = {
  type: 'source',
  label: 'Source',
  category: 'Test',
  inputs: [],
  outputs: [{ id: 'out', label: 'Out', type: 'geometry' }],
};
const join: NodeSchema = {
  type: 'join',
  label: 'Join',
  category: 'Test',
  inputs: [
    { id: 'a', label: 'A', type: 'geometry' },
    { id: 'b', label: 'B', type: 'geometry' },
  ],
  outputs: [{ id: 'out', label: 'Out', type: 'geometry' }],
};

function graph(): Graph {
  const registry = new NodeRegistry<NodeSchema>();
  registry.registerAll([source, solid('step'), join]);
  return new Graph(registry);
}

function chain(g: Graph, ids: string[]): void {
  g.addNode('source', { id: ids[0]! });
  for (const [index, id] of ids.slice(1).entries()) {
    g.addNode('step', { id });
    g.connect({ node: ids[index]!, port: 'out' }, { node: id, port: 'in' });
  }
}

/** Whether any two nodes' boxes, with the margin, overlap. */
function overlapping(g: Graph, plan: Map<string, { x: number; y: number }>): string[] {
  const boxes = [...plan].map(([id, at]) => ({ id, ...at, h: nodeHeight(g.schemaOf(id)) }));
  const clashes: string[] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const sideways = Math.abs(a.x - b.x) < NODE_WIDTH;
      const vertical = a.y < b.y + b.h + ROW_GAP - 0.5 && b.y < a.y + a.h + ROW_GAP - 0.5;
      if (sideways && vertical) clashes.push(`${a.id}/${b.id}`);
    }
  }
  return clashes;
}

describe('laying out the graph', () => {
  it('puts each node a column right of what it reads', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    const plan = planLayout(g);
    expect(plan.get('a')!.x).toBeLessThan(plan.get('b')!.x);
    expect(plan.get('b')!.x).toBeLessThan(plan.get('c')!.x);
  });

  it('lines a chain up level, so its wires are straight', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    g.setPosition('b', { x: 0, y: 300 });
    const plan = planLayout(g);
    const heights = [...plan.values()].map((at) => at.y);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(3);
  });

  it('gives a node spliced into a chain its own column, and moves what follows along', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    const before = planLayout(g);
    // x goes in between a and b, the way a splice puts it there.
    g.disconnect(g.incomingEdge('b', 'in')!.id);
    g.addNode('step', { id: 'x' });
    g.connect({ node: 'a', port: 'out' }, { node: 'x', port: 'in' });
    g.connect({ node: 'x', port: 'out' }, { node: 'b', port: 'in' });
    const after = planLayout(g);

    expect(after.get('x')!.x).toBe(before.get('b')!.x);
    expect(after.get('b')!.x).toBeGreaterThan(before.get('b')!.x);
    expect(after.get('c')!.x).toBeGreaterThan(before.get('c')!.x);
  });

  it('pulls a node nothing feeds up against the first thing that reads it', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    g.addNode('source', { id: 'late' });
    g.addNode('join', { id: 'j' });
    g.connect({ node: 'c', port: 'out' }, { node: 'j', port: 'a' });
    g.connect({ node: 'late', port: 'out' }, { node: 'j', port: 'b' });
    const plan = planLayout(g);
    expect(plan.get('late')!.x).toBe(plan.get('c')!.x);
  });

  it('never leaves two nodes on top of each other', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    chain(g, ['d', 'e', 'f']);
    chain(g, ['g', 'h', 'i']);
    // Everything dropped in one place, as a careless import might.
    for (const node of g.allNodes()) g.setPosition(node.id, { x: 0, y: 0 });
    expect(overlapping(g, planLayout(g))).toEqual([]);
  });

  it('orders a column to take the crossing out of two wires', () => {
    const g = graph();
    g.addNode('source', { id: 'top', position: { x: 0, y: 0 } });
    g.addNode('source', { id: 'bottom', position: { x: 0, y: 400 } });
    g.addNode('step', { id: 'readsTop', position: { x: 320, y: 400 } });
    g.addNode('step', { id: 'readsBottom', position: { x: 320, y: 0 } });
    g.connect({ node: 'top', port: 'out' }, { node: 'readsTop', port: 'in' });
    g.connect({ node: 'bottom', port: 'out' }, { node: 'readsBottom', port: 'in' });
    const plan = planLayout(g);
    const above = (a: string, b: string): boolean => plan.get(a)!.y < plan.get(b)!.y;
    expect(above('top', 'bottom')).toBe(above('readsTop', 'readsBottom'));
  });

  it('leaves a pinned node where it was put, and lays the rest out around it', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    g.setPosition('b', { x: 777, y: 555 });
    g.setPinned('b', true);
    const plan = planLayout(g);
    expect(plan.get('b')).toEqual({ x: 777, y: 555 });
    expect(plan.get('c')!.x).toBeGreaterThan(777);
    expect(overlapping(g, plan)).toEqual([]);
  });

  it('holds a node being dragged as if it were pinned, so the others make room', () => {
    const g = graph();
    chain(g, ['a', 'b']);
    chain(g, ['c', 'd']);
    const settled = planLayout(g);
    for (const [id, at] of settled) g.setPosition(id, at);
    // c dragged onto the top of a.
    const plan = planLayout(g, { hold: new Map([['c', settled.get('a')!]]) });
    expect(plan.get('c')).toEqual(settled.get('a'));
    expect(overlapping(g, plan)).toEqual([]);
  });

  it('has nothing left to do once it has settled', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c']);
    chain(g, ['d', 'e']);
    g.addNode('join', { id: 'j' });
    g.connect({ node: 'c', port: 'out' }, { node: 'j', port: 'a' });
    g.connect({ node: 'e', port: 'out' }, { node: 'j', port: 'b' });
    const first = planLayout(g);
    for (const [id, at] of first) g.setPosition(id, at);
    const second = planLayout(g);
    for (const [id, at] of second) {
      expect(Math.abs(at.x - first.get(id)!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(at.y - first.get(id)!.y)).toBeLessThanOrEqual(2);
    }
  });

  it('survives being saved and opened with a node pinned', () => {
    const g = graph();
    chain(g, ['a', 'b']);
    g.setPinned('b', true);
    const reopened = graph();
    reopened.restore(g.toJSON());
    expect(reopened.getNode('b')!.pinned).toBe(true);
    expect(reopened.getNode('a')!.pinned).toBeUndefined();
  });

  it('lets a new node join a chain without dragging the chain to where it was made', () => {
    const g = graph();
    chain(g, ['a', 'b']);
    for (const [id, at] of planLayout(g)) g.setPosition(id, at);
    const before = g.getNode('a')!.position.y;
    // Made far below everything, as placing it clear of the others leaves it.
    g.addNode('step', { id: 'c', position: { x: 0, y: before + 2000 } });
    g.connect({ node: 'b', port: 'out' }, { node: 'c', port: 'in' });
    const plan = planLayout(g, { fresh: new Set(['c']) });
    expect(Math.abs(plan.get('a')!.y - before)).toBeLessThanOrEqual(2);
    expect(Math.abs(plan.get('c')!.y - before)).toBeLessThanOrEqual(2);
  });

  it('does not drag a whole chain after a node pinned away from it', () => {
    const g = graph();
    chain(g, ['a', 'b', 'c', 'd']);
    for (const [id, at] of planLayout(g)) g.setPosition(id, at);
    const before = g.getNode('d')!.position.y;
    g.setPosition('a', { x: g.getNode('a')!.position.x, y: before + 400 });
    g.setPinned('a', true);
    const plan = planLayout(g);
    // The far end of the chain barely notices; only the pinned end moved.
    expect(Math.abs(plan.get('d')!.y - before)).toBeLessThan(60);
  });
});
