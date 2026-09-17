import { describe, expect, it } from 'vitest';
import type { Sketch } from './model.js';
import { solveSketch } from './solver.js';

const dims = (entries: Record<string, number>) => new Map(Object.entries(entries));

/** Four corners, drawn sloppily, joined into a loop. */
function roughQuad(): Sketch {
  return {
    points: [
      { u: 0.4, v: -0.3 },
      { u: 52, v: 1.7 },
      { u: 49, v: 31 },
      { u: -1.2, v: 28 },
    ],
    entities: [
      { kind: 'line', a: 0, b: 1 },
      { kind: 'line', a: 1, b: 2 },
      { kind: 'line', a: 2, b: 3 },
      { kind: 'line', a: 3, b: 0 },
    ],
    constraints: [],
  };
}

describe('solving a sketch', () => {
  it('pulls a rough quadrilateral into an exact rectangle', () => {
    const sketch = roughQuad();
    sketch.constraints = [
      { kind: 'lockU', point: 0, dimension: 'originU' },
      { kind: 'lockV', point: 0, dimension: 'originV' },
      { kind: 'horizontal', line: 0 },
      { kind: 'horizontal', line: 2 },
      { kind: 'vertical', line: 1 },
      { kind: 'vertical', line: 3 },
      { kind: 'horizontalDistance', a: 0, b: 1, dimension: 'width' },
      { kind: 'verticalDistance', a: 0, b: 3, dimension: 'height' },
    ];

    const result = solveSketch(sketch, dims({ originU: 0, originV: 0, width: 50, height: 30 }));

    expect(result.solved).toBe(true);
    expect(result.freedom).toBe(0);
    expect(result.points[0]!.u).toBeCloseTo(0, 7);
    expect(result.points[0]!.v).toBeCloseTo(0, 7);
    expect(result.points[1]!.u).toBeCloseTo(50, 7);
    expect(result.points[1]!.v).toBeCloseTo(0, 7);
    expect(result.points[2]!.u).toBeCloseTo(50, 7);
    expect(result.points[2]!.v).toBeCloseTo(30, 7);
    expect(result.points[3]!.u).toBeCloseTo(0, 7);
    expect(result.points[3]!.v).toBeCloseTo(30, 7);
  });

  it('follows a dimension when it changes', () => {
    const sketch = roughQuad();
    sketch.constraints = [
      { kind: 'lockU', point: 0, dimension: 'originU' },
      { kind: 'lockV', point: 0, dimension: 'originV' },
      { kind: 'horizontal', line: 0 },
      { kind: 'horizontal', line: 2 },
      { kind: 'vertical', line: 1 },
      { kind: 'vertical', line: 3 },
      { kind: 'horizontalDistance', a: 0, b: 1, dimension: 'width' },
      { kind: 'verticalDistance', a: 0, b: 3, dimension: 'height' },
    ];

    const wide = solveSketch(sketch, dims({ originU: 0, originV: 0, width: 120, height: 30 }));
    expect(wide.solved).toBe(true);
    expect(wide.points[1]!.u).toBeCloseTo(120, 9);
    expect(wide.points[2]!.u).toBeCloseTo(120, 9);
  });

  it('counts the freedom a half-constrained sketch still has', () => {
    const sketch = roughQuad();
    // A rectangle, but nothing says where it is: two unknowns of position left.
    sketch.constraints = [
      { kind: 'horizontal', line: 0 },
      { kind: 'horizontal', line: 2 },
      { kind: 'vertical', line: 1 },
      { kind: 'vertical', line: 3 },
      { kind: 'horizontalDistance', a: 0, b: 1, dimension: 'width' },
      { kind: 'verticalDistance', a: 0, b: 3, dimension: 'height' },
    ];

    const result = solveSketch(sketch, dims({ width: 50, height: 30 }));
    expect(result.solved).toBe(true);
    expect(result.freedom).toBe(2);
  });

  it('reports a constraint that repeats one already there', () => {
    const sketch = roughQuad();
    sketch.constraints = [
      { kind: 'horizontal', line: 0 },
      { kind: 'horizontal', line: 0 },
    ];

    const result = solveSketch(sketch, dims({}));
    expect(result.solved).toBe(true);
    expect(result.redundant).toBe(1);
  });

  it('refuses to pretend a contradiction was solved', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 10, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'distance', a: 0, b: 1, dimension: 'short' },
        { kind: 'distance', a: 0, b: 1, dimension: 'long' },
      ],
    };

    const result = solveSketch(sketch, dims({ short: 10, long: 40 }));
    expect(result.solved).toBe(false);
    expect(result.worst).toBeGreaterThan(1);
  });

  it('makes two lines perpendicular and equal', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 20, v: 3 },
        { u: 1, v: 14 },
      ],
      entities: [
        { kind: 'line', a: 0, b: 1 },
        { kind: 'line', a: 0, b: 2 },
      ],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'perpendicular', a: 0, b: 1 },
        { kind: 'equal', a: 0, b: 1 },
        { kind: 'distance', a: 0, b: 1, dimension: 'side' },
        { kind: 'horizontal', line: 0 },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0, side: 25 }));
    expect(result.solved).toBe(true);

    const [origin, along, across] = result.points as [
      { u: number; v: number },
      { u: number; v: number },
      { u: number; v: number },
    ];
    expect(Math.hypot(along.u - origin.u, along.v - origin.v)).toBeCloseTo(25, 8);
    expect(Math.hypot(across.u - origin.u, across.v - origin.v)).toBeCloseTo(25, 8);
    const dot =
      (along.u - origin.u) * (across.u - origin.u) + (along.v - origin.v) * (across.v - origin.v);
    expect(dot).toBeCloseTo(0, 6);
  });

  it('solves a circle radius and keeps two circles concentric', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 3, v: -2 },
      ],
      entities: [
        { kind: 'circle', centre: 0, radius: 5 },
        { kind: 'circle', centre: 1, radius: 9 },
      ],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'concentric', a: 0, b: 1 },
        { kind: 'radius', circle: 0, dimension: 'bore' },
        { kind: 'radius', circle: 1, dimension: 'boss' },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0, bore: 4, boss: 12 }));
    expect(result.solved).toBe(true);
    expect(result.radii[0]).toBeCloseTo(4, 9);
    expect(result.radii[1]).toBeCloseTo(12, 9);
    expect(result.points[1]!.u).toBeCloseTo(0, 8);
    expect(result.points[1]!.v).toBeCloseTo(0, 8);
  });

  it('holds an angle between two lines', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 30, v: 0 },
        { u: 20, v: 5 },
      ],
      entities: [
        { kind: 'line', a: 0, b: 1 },
        { kind: 'line', a: 0, b: 2 },
      ],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'horizontal', line: 0 },
        { kind: 'distance', a: 0, b: 1, dimension: 'run' },
        { kind: 'distance', a: 0, b: 2, dimension: 'run' },
        { kind: 'angle', a: 0, b: 1, dimension: 'opening' },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0, run: 30, opening: 60 }));
    expect(result.solved).toBe(true);
    expect(result.points[2]!.u).toBeCloseTo(30 * Math.cos(Math.PI / 3), 7);
    expect(result.points[2]!.v).toBeCloseTo(30 * Math.sin(Math.PI / 3), 7);
  });

  it('settles on the nearest solution rather than wandering a free direction', () => {
    // Equal holds anywhere along a bisector, so there is a long way to travel.
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
        { u: 25, v: 20 },
      ],
      entities: [
        { kind: 'line', a: 0, b: 1 },
        { kind: 'line', a: 1, b: 2 },
        { kind: 'line', a: 2, b: 0 },
      ],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'horizontal', line: 0 },
        { kind: 'equal', a: 1, b: 2 },
      ],
    };

    const before = sketch.points.map((point) => ({ ...point }));
    const result = solveSketch(sketch, dims({ zero: 0 }));
    expect(result.solved).toBe(true);

    // The two slopes end up matching, which is what was asked for.
    const [p0, p1, p2] = result.points as [typeof before[0], typeof before[0], typeof before[0]];
    expect(Math.hypot(p2.u - p1.u, p2.v - p1.v)).toBeCloseTo(
      Math.hypot(p0.u - p2.u, p0.v - p2.v),
      6,
    );

    // And it got there by nudging, not by sliding down the bisector: every point
    // is still within a few millimetres of where it was drawn.
    for (const [index, point] of result.points.entries()) {
      expect(Math.hypot(point.u - before[index]!.u, point.v - before[index]!.v)).toBeLessThan(6);
    }
  });

  it('puts a point at the middle of a line and on it', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 10 },
        { u: 5, v: 30 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'lockU', point: 1, dimension: 'far' },
        { kind: 'lockV', point: 1, dimension: 'high' },
        { kind: 'midpoint', point: 2, line: 0 },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0, far: 40, high: 10 }));
    expect(result.solved).toBe(true);
    expect(result.points[2]!.u).toBeCloseTo(20, 9);
    expect(result.points[2]!.v).toBeCloseTo(5, 9);
  });

  it('lets a loose point follow the cursor exactly', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0 }), {
      pull: [{ point: 1, to: { u: 25, v: 18 } }],
    });

    expect(result.solved).toBe(true);
    expect(result.points[1]!.u).toBeCloseTo(25, 4);
    expect(result.points[1]!.v).toBeCloseTo(18, 4);
  });

  it('slides a dragged point along what holds it rather than breaking it', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'horizontal', line: 0 },
      ],
    };

    // Dragged up and to the right; the line is horizontal, so only the right
    // part of that can be honoured.
    const result = solveSketch(sketch, dims({ zero: 0 }), {
      pull: [{ point: 1, to: { u: 25, v: 18 } }],
    });

    expect(result.solved).toBe(true);
    expect(result.points[1]!.u).toBeCloseTo(25, 3);
    expect(result.points[1]!.v).toBeCloseTo(0, 6);
  });

  it('will not drag a sketch that is fully dimensioned', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'lockU', point: 1, dimension: 'far' },
        { kind: 'lockV', point: 1, dimension: 'zero' },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0, far: 40 }), {
      pull: [{ point: 1, to: { u: 25, v: 18 } }],
    });

    expect(result.solved).toBe(true);
    expect(result.points[1]!.u).toBeCloseTo(40, 6);
    expect(result.points[1]!.v).toBeCloseTo(0, 6);
  });

  it('carries the rest of the drawing along with a dragged point', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
        { u: 20, v: 0 },
      ],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [
        { kind: 'lockU', point: 0, dimension: 'zero' },
        { kind: 'lockV', point: 0, dimension: 'zero' },
        { kind: 'midpoint', point: 2, line: 0 },
      ],
    };

    const result = solveSketch(sketch, dims({ zero: 0 }), {
      pull: [{ point: 1, to: { u: 40, v: 20 } }],
    });

    expect(result.solved).toBe(true);

    // The midpoint is still exactly the midpoint, and the dragged end is where
    // it was asked to go, give or take the last pass settling the constraints.
    expect(result.points[2]!.u).toBeCloseTo((result.points[0]!.u + result.points[1]!.u) / 2, 9);
    expect(result.points[2]!.v).toBeCloseTo((result.points[0]!.v + result.points[1]!.v) / 2, 9);
    expect(Math.abs(result.points[1]!.v - 20)).toBeLessThan(0.2);
  });
});
