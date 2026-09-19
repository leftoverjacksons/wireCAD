import { describe, expect, it } from 'vitest';
import {
  annotate,
  annotateOne,
  chooseSpan,
  dashesAlong,
  dashesAround,
  decodePlaces,
  encodePlaces,
  formatLength,
  placeOf,
} from './annotate.js';
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

describe('placing a dimension', () => {
  const from = { u: 0, v: 0 };
  const to = { u: 40, v: 30 };

  it('reads a placement out to the side of a diagonal as its length', () => {
    // Straight off the line, perpendicular to it.
    const { kind } = chooseSpan(from, to, { u: 8, v: 26 });
    expect(kind).toBe('distance');
  });

  it('reads one placed above it as the width it covers', () => {
    const { kind } = chooseSpan(from, to, { u: 20, v: 60 });
    expect(kind).toBe('horizontalDistance');
  });

  it('reads one placed beside it as the height it covers', () => {
    const { kind } = chooseSpan(from, to, { u: 70, v: 15 });
    expect(kind).toBe('verticalDistance');
  });

  it('offers nothing but the length of a span already square to an axis', () => {
    for (const cursor of [{ u: 20, v: 30 }, { u: 60, v: 0 }]) {
      expect(chooseSpan({ u: 0, v: 0 }, { u: 40, v: 0 }, cursor).kind).toBe('distance');
    }
  });

  it('puts the number where the cursor left it', () => {
    const cursor = { u: 9, v: 44 };
    const { kind, place } = chooseSpan(from, to, cursor);
    const sketch = {
      points: [from, to],
      entities: [],
      constraints: [{ kind, a: 0, b: 1, dimension: 'd' } as const],
    };
    const drawn = annotateOne(sketch, sketch.constraints[0]!, 0, sketch.points, [], 40, 1, place, {
      u: 0,
      v: 0,
    });

    expect(drawn!.label.u).toBeCloseTo(cursor.u, 6);
    expect(drawn!.label.v).toBeCloseTo(cursor.v, 6);
  });

  it('keeps a placement with the geometry as it moves', () => {
    const sketch = {
      points: [from, to],
      entities: [],
      constraints: [{ kind: 'distance', a: 0, b: 1, dimension: 'd' } as const],
    };
    const place = placeOf(sketch, sketch.constraints[0]!, sketch.points, { u: 8, v: 26 })!;

    // The same rule, drawn against points that have since moved bodily sideways.
    const moved = [
      { u: 10, v: 10 },
      { u: 50, v: 40 },
    ];
    const drawn = annotateOne(sketch, sketch.constraints[0]!, 0, moved, [], 50, 1, place, {
      u: 0,
      v: 0,
    });

    expect(drawn!.label.u).toBeCloseTo(18, 6);
    expect(drawn!.label.v).toBeCloseTo(36, 6);
  });

  it('travels as a flat list and comes back the same', () => {
    const places = new Map([
      ['length1', { offset: -12.5, slide: 3 }],
      ['radius1', { offset: 20, slide: 0.75 }],
    ]);
    expect(decodePlaces(encodePlaces(places))).toEqual(places);
    expect(decodePlaces(['bad', 'worse', 0])).toEqual(new Map());
    expect(decodePlaces(null)).toEqual(new Map());
  });
});

describe('formatLength', () => {
  it('writes a whole number plainly and a fraction briefly', () => {
    expect(formatLength(40)).toBe('40');
    expect(formatLength(12.5)).toBe('12.5');
    expect(formatLength(12.345)).toBe('12.35');
  });
});

describe('dashesAlong', () => {
  const a = { u: 0, v: 0 };
  const b = { u: 100, v: 0 };

  it('starts at one end and finishes at the other', () => {
    const drawn = dashesAlong(a, b, 1);

    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn[0]![0]).toEqual(a);
    expect(drawn[drawn.length - 1]![1]!.u).toBeCloseTo(b.u, 9);
  });

  it('stays on the line it dashes', () => {
    const drawn = dashesAlong({ u: 0, v: 0 }, { u: 30, v: 40 }, 1);

    for (const [from, to] of drawn) {
      // The line is 3-4-5: every point on it has v exactly four thirds of u.
      expect(from.v).toBeCloseTo((from.u * 4) / 3, 9);
      expect(to.v).toBeCloseTo((to.u * 4) / 3, 9);
    }
  });

  it('draws in pixels, so leaning in gives more dashes and not bigger ones', () => {
    // Half the millimetres to the pixel is twice the zoom.
    const near = dashesAlong(a, b, 1);
    const far = dashesAlong(a, b, 0.5);
    const dashOf = (drawn: ReturnType<typeof dashesAlong>): number =>
      Math.hypot(drawn[0]![1]!.u - drawn[0]![0]!.u, drawn[0]![1]!.v - drawn[0]![0]!.v);

    // Not exactly double and exactly half: the pattern is fitted to the line,
    // so the count is whole and the dash is the size that then falls out of it.
    expect(Math.abs(far.length - near.length * 2)).toBeLessThanOrEqual(1);
    expect(dashOf(far) / (dashOf(near) / 2)).toBeCloseTo(1, 1);
    expect(dashOf(far)).toBeLessThan(dashOf(near));
  });

  it('keeps a whole dash on a line too short for one', () => {
    expect(dashesAlong(a, { u: 2, v: 0 }, 1)).toEqual([[a, { u: 2, v: 0 }]]);
  });

  it('starts and finishes on a dash, as a dashed line is drawn', () => {
    for (const span of [18, 37.5, 61, 140]) {
      const drawn = dashesAlong(a, { u: span, v: 0 }, 1);
      expect(drawn[0]![0]!.u).toBeCloseTo(0, 9);
      expect(drawn[drawn.length - 1]![1]!.u).toBeCloseTo(span, 9);
    }
  });

  it('stretches the pattern rather than drawing thousands of dashes', () => {
    // A metre of line seen from far enough away to fit it on screen.
    const drawn = dashesAlong(a, { u: 1000, v: 0 }, 0.01);

    expect(drawn.length).toBeLessThanOrEqual(120);
    expect(drawn[drawn.length - 1]![1]!.u).toBeCloseTo(1000, 6);
  });

  it('has nothing to draw for a line of no length', () => {
    expect(dashesAlong(a, a, 1)).toEqual([]);
  });
});

describe('dashesAround', () => {
  const centre = { u: 5, v: -3 };
  const radius = 40;

  const lengthOf = (arc: readonly { u: number; v: number }[]): number => {
    let total = 0;
    for (let i = 1; i < arc.length; i++) {
      total += Math.hypot(arc[i]!.u - arc[i - 1]!.u, arc[i]!.v - arc[i - 1]!.v);
    }
    return total;
  };

  it('stays on the circle it dashes', () => {
    for (const arc of dashesAround(centre, radius, 1)) {
      for (const point of arc) {
        expect(Math.hypot(point.u - centre.u, point.v - centre.v)).toBeCloseTo(radius, 6);
      }
    }
  });

  it('spaces the dashes evenly all the way round', () => {
    const drawn = dashesAround(centre, radius, 1);
    expect(drawn.length).toBeGreaterThan(4);

    const first = lengthOf(drawn[0]!);
    for (const arc of drawn) expect(lengthOf(arc)).toBeCloseTo(first, 6);

    // A closed curve has no ends, so every dash is followed by a gap and the
    // pattern divides the circumference exactly.
    const gap = Math.hypot(
      drawn[1]![0]!.u - drawn[0]![drawn[0]!.length - 1]!.u,
      drawn[1]![0]!.v - drawn[0]![drawn[0]!.length - 1]!.v,
    );
    expect(drawn.length * (first + gap)).toBeCloseTo(2 * Math.PI * radius, 0);
  });

  it('draws in pixels, so leaning in gives more dashes and not bigger ones', () => {
    const near = dashesAround(centre, radius, 1);
    const far = dashesAround(centre, radius, 0.5);

    expect(Math.abs(far.length - near.length * 2)).toBeLessThanOrEqual(1);
    expect(lengthOf(far[0]!)).toBeLessThan(lengthOf(near[0]!));
  });

  it('curves a dash on a circle small enough for it to show', () => {
    // A dash spanning a good part of the circle is drawn as several pieces
    // rather than as the chord across it.
    const tiny = dashesAround(centre, 2, 1);
    expect(tiny.every((arc) => arc.length > 2)).toBe(true);
  });

  it('has nothing to draw for a circle of no radius', () => {
    expect(dashesAround(centre, 0, 1)).toEqual([]);
  });
});
