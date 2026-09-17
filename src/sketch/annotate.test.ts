import { describe, expect, it } from 'vitest';
import { annotate, formatLength } from './annotate.js';
import type { Sketch } from './model.js';

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

describe('annotate', () => {
  it('leaves the origin lock alone, since it measures nothing', () => {
    const sketch = withConstraints([
      { kind: 'lockU', point: 0, dimension: 'originU' },
      { kind: 'lockV', point: 0, dimension: 'originV' },
    ]);

    expect(annotate(sketch, sketch.points, [], new Map(), 1)).toEqual([]);
  });

  it('puts a length outside the shape, not across it', () => {
    const sketch = withConstraints([{ kind: 'distance', a: 0, b: 1, dimension: 'length1' }]);
    const [drawn] = annotate(sketch, sketch.points, [], new Map([['length1', 40]]), 1);

    expect(drawn?.text).toBe('40');
    // The base runs along v = 0 and the square sits above it, so the dimension
    // belongs below.
    expect(drawn!.label.v).toBeLessThan(0);
    expect(drawn!.lines.length).toBeGreaterThan(4);
  });

  it('measures a vertical distance up the V axis', () => {
    const sketch = withConstraints([
      { kind: 'verticalDistance', a: 0, b: 3, dimension: 'height' },
    ]);
    const [drawn] = annotate(sketch, sketch.points, [], new Map([['height', 30]]), 1);

    const dimensionLine = drawn!.lines[2]!;
    expect(dimensionLine[0]!.u).toBeCloseTo(dimensionLine[1]!.u, 9);
    expect(Math.abs(dimensionLine[1]!.v - dimensionLine[0]!.v)).toBeCloseTo(30, 9);
  });

  it('writes a radius with its R', () => {
    const sketch: Sketch = {
      points: [{ u: 10, v: 10 }],
      entities: [{ kind: 'circle', centre: 0, radius: 6 }],
      constraints: [{ kind: 'radius', circle: 0, dimension: 'radius1' }],
    };
    const [drawn] = annotate(sketch, sketch.points, [6], new Map([['radius1', 6]]), 1);

    expect(drawn?.text).toBe('R6');
    // The leader starts at the centre and reaches past the rim.
    expect(drawn!.lines[0]![0]).toEqual({ u: 10, v: 10 });
  });

  it('draws an angle as an arc at the corner the lines make', () => {
    const sketch = withConstraints([{ kind: 'angle', a: 0, b: 1, dimension: 'angle1' }]);
    const [drawn] = annotate(sketch, sketch.points, [], new Map([['angle1', 90]]), 1);

    expect(drawn?.text).toBe('90°');
    // Every segment of the arc sits the same distance from the corner.
    const corner = { u: 40, v: 0 };
    const radii = drawn!.lines.map(([from]) => Math.hypot(from.u - corner.u, from.v - corner.v));
    for (const radius of radii) expect(radius).toBeCloseTo(radii[0]!, 6);
  });

  it('keeps its size on screen rather than in the model', () => {
    const sketch = withConstraints([{ kind: 'distance', a: 0, b: 1, dimension: 'length1' }]);
    const near = annotate(sketch, sketch.points, [], new Map([['length1', 40]]), 1);
    const far = annotate(sketch, sketch.points, [], new Map([['length1', 40]]), 4);

    // Zoomed out, a pixel is worth more millimetres, so the offset grows with it.
    expect(Math.abs(far[0]!.label.v)).toBeCloseTo(Math.abs(near[0]!.label.v) * 4, 6);
  });
});

describe('formatLength', () => {
  it('writes a whole number plainly and a fraction briefly', () => {
    expect(formatLength(40)).toBe('40');
    expect(formatLength(12.5)).toBe('12.5');
    expect(formatLength(12.345)).toBe('12.35');
  });
});
