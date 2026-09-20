import { describe, expect, it } from 'vitest';
import type { Sketch } from '../sketch/model.js';
import type { Selection } from './sketch-session.js';
import { RELATIONS } from './sketch-session.js';

/** A rectangle with a loose point inside it, which is where relations get used. */
const SKETCH: Sketch = {
  points: [
    { u: 0, v: 0 },
    { u: 60, v: 0 },
    { u: 60, v: 40 },
    { u: 0, v: 40 },
    { u: 30, v: 26 },
  ],
  entities: [
    { kind: 'line', a: 0, b: 1 },
    { kind: 'line', a: 1, b: 2 },
    { kind: 'line', a: 2, b: 3 },
    { kind: 'line', a: 3, b: 0 },
    { kind: 'circle', centre: 4, radius: 8 },
  ],
  constraints: [],
};

const relation = (id: string) => RELATIONS.find((entry) => entry.id === id)!;
const point = (index: number): Selection => ({ kind: 'point', index });
const entity = (index: number): Selection => ({ kind: 'entity', index });

describe('coincident', () => {
  it('makes two points the same point', () => {
    const picked = [point(4), point(2)];
    expect(relation('coincident').check(picked, SKETCH)).toBeNull();
    expect(relation('coincident').apply(picked, SKETCH)).toEqual([
      { kind: 'coincident', a: 4, b: 2 },
    ]);
  });

  it('puts a point on a line, which is what coincident means against an edge', () => {
    const picked = [point(4), entity(1)];
    expect(relation('coincident').check(picked, SKETCH)).toBeNull();
    expect(relation('coincident').apply(picked, SKETCH)).toEqual([
      { kind: 'pointOnLine', point: 4, line: 1 },
    ]);
  });

  it('says so when asked for a point on a circle, rather than doing nothing', () => {
    const problem = relation('coincident').check([point(0), entity(4)], SKETCH);
    expect(problem).toMatch(/circle/);
  });

  it('asks for the picks it can use when given something else', () => {
    expect(relation('coincident').check([entity(0), entity(1)], SKETCH)).toMatch(
      /two points, or a point and a line/,
    );
    expect(relation('coincident').check([point(0)], SKETCH)).not.toBeNull();
  });
});

describe('on line', () => {
  it('is the same rule under a name of its own', () => {
    const picked = [point(4), entity(1)];
    expect(relation('pointOnLine').check(picked, SKETCH)).toBeNull();
    expect(relation('pointOnLine').apply(picked, SKETCH)).toEqual(
      relation('coincident').apply(picked, SKETCH),
    );
  });
});
