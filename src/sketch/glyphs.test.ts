import { describe, expect, it } from 'vitest';
import { glyphsFor } from './glyphs.js';
import type { Sketch } from './model.js';

/** A square, drawn anticlockwise from the origin. */
const SQUARE: Sketch = {
  points: [
    { u: 0, v: 0 },
    { u: 40, v: 0 },
    { u: 40, v: 30 },
    { u: 0, v: 30 },
  ],
  entities: [
    { kind: 'line', a: 0, b: 1 },
    { kind: 'line', a: 1, b: 2 },
    { kind: 'line', a: 2, b: 3 },
    { kind: 'line', a: 3, b: 0 },
  ],
  constraints: [],
};

function withConstraints(constraints: Sketch['constraints']): Sketch {
  return { ...SQUARE, constraints };
}

describe('glyphsFor', () => {
  it('draws nothing for a dimension, which shows itself', () => {
    const sketch = withConstraints([
      { kind: 'distance', a: 0, b: 1, dimension: 'length1' },
      { kind: 'lockU', point: 0, dimension: 'originU' },
      { kind: 'lockV', point: 0, dimension: 'originV' },
    ]);

    expect(glyphsFor(sketch, sketch.points, 1)).toEqual([]);
  });

  it('puts a horizontal mark outside the edge it belongs to', () => {
    const sketch = withConstraints([{ kind: 'horizontal', line: 0 }]);
    const [glyph] = glyphsFor(sketch, sketch.points, 1);

    expect(glyph?.kind).toBe('horizontal');
    // The base runs along v = 0 with the square above it, so its mark sits below.
    expect(glyph!.at.v).toBeLessThan(0);
    expect(glyph!.at.u).toBeCloseTo(20, 6);
  });

  it('marks both edges of a relation between two of them', () => {
    const sketch = withConstraints([{ kind: 'equal', a: 1, b: 3 }]);
    const drawn = glyphsFor(sketch, sketch.points, 1);

    expect(drawn.length).toBe(2);
    expect(drawn.every((glyph) => glyph.kind === 'equal')).toBe(true);
    // Both belong to the same rule, so picking one picks the relation.
    expect(new Set(drawn.map((glyph) => glyph.constraint))).toEqual(new Set([0]));
    // One on each edge, which are 40 mm apart.
    expect(Math.abs(drawn[0]!.at.u - drawn[1]!.at.u)).toBeGreaterThan(40);
  });

  it('spreads two marks on one edge instead of stacking them', () => {
    const sketch = withConstraints([
      { kind: 'horizontal', line: 0 },
      { kind: 'equal', a: 0, b: 2 },
    ]);
    const onBase = glyphsFor(sketch, sketch.points, 1).filter((glyph) => glyph.at.v < 0);

    expect(onBase.length).toBe(2);
    expect(Math.abs(onBase[0]!.at.u - onBase[1]!.at.u)).toBeGreaterThan(8);
    // Both still belong to the middle of the edge rather than trailing away.
    for (const glyph of onBase) expect(Math.abs(glyph.at.u - 20)).toBeLessThan(20);
  });

  it('keeps its size on screen rather than in the model', () => {
    const sketch = withConstraints([{ kind: 'vertical', line: 1 }]);
    const near = glyphsFor(sketch, sketch.points, 1)[0]!;
    const far = glyphsFor(sketch, sketch.points, 3)[0]!;

    const span = (glyph: typeof near): number =>
      Math.max(...glyph.lines.flat().map((point) => Math.hypot(point.u - glyph.at.u, point.v - glyph.at.v)));
    expect(span(far)).toBeCloseTo(span(near) * 3, 6);
  });

  it('steps a mark aside rather than drawing it over another', () => {
    // A midpoint hangs off the point; horizontal hangs off the edge through it.
    // Left alone they would land on each other.
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
        { u: 20, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'midpoint', point: 2, line: 0 },
        { kind: 'horizontal', line: 0 },
      ],
    };

    const drawn = glyphsFor(sketch, sketch.points, 1);
    expect(drawn.length).toBe(2);
    const apart = Math.hypot(
      drawn[0]!.at.u - drawn[1]!.at.u,
      drawn[0]!.at.v - drawn[1]!.at.v,
    );
    expect(apart).toBeGreaterThan(11);
  });

  it('sits a point relation beside the point it names', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
        { u: 20, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [{ kind: 'midpoint', point: 2, line: 0 }],
    };
    const [glyph] = glyphsFor(sketch, sketch.points, 1);

    expect(glyph?.kind).toBe('midpoint');
    expect(Math.hypot(glyph!.at.u - 20, glyph!.at.v - 0)).toBeLessThan(30);
    expect(glyph!.at).not.toEqual({ u: 20, v: 0 });
  });
});
