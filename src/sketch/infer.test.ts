import { describe, expect, it } from 'vitest';
import { inferCircle, inferDimensions, inferSketch } from './infer.js';
import { dimensionsOf } from './model.js';
import { solveSketch } from './solver.js';

const rect = [
  { u: 0, v: 0 },
  { u: 50, v: 0 },
  { u: 50, v: 30 },
  { u: 0, v: 30 },
];

describe('inferring constraints from a drawing', () => {
  it('names a drawn rectangle by width and height', () => {
    const sketch = inferSketch(rect);
    expect(dimensionsOf(sketch)).toEqual(['originU', 'originV', 'width', 'height']);
  });

  it('leaves the rectangle exactly determined, with nothing redundant', () => {
    const sketch = inferSketch(rect);
    const values = inferDimensions(sketch, rect);
    const dims = new Map<string, number>();
    for (let i = 0; i + 1 < values.length; i += 2) {
      dims.set(values[i] as unknown as string, values[i + 1]!);
    }

    const result = solveSketch(sketch, dims);
    expect(result.solved).toBe(true);
    expect(result.freedom).toBe(0);
    expect(result.redundant).toBe(0);
  });

  it('drives the shape from the dimensions it named', () => {
    const sketch = inferSketch(rect);
    const result = solveSketch(
      sketch,
      new Map([
        ['originU', 0],
        ['originV', 0],
        ['width', 80],
        ['height', 12],
      ]),
    );

    expect(result.solved).toBe(true);
    expect(result.points[1]!.u).toBeCloseTo(80, 9);
    expect(result.points[2]!.v).toBeCloseTo(12, 9);
  });

  it('claims no lengths for a shape it cannot name', () => {
    const wedge = [
      { u: 0, v: 0 },
      { u: 40, v: 0 },
      { u: 25, v: 20 },
    ];
    const sketch = inferSketch(wedge);

    // The flat bottom edge is still recognised; nothing else is invented.
    expect(sketch.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1);
    expect(dimensionsOf(sketch)).toEqual(['originU', 'originV']);

    const result = solveSketch(sketch, new Map([['originU', 0], ['originV', 0]]));
    expect(result.solved).toBe(true);
    // Two points free in both axes, less the one relation holding the base flat.
    expect(result.freedom).toBe(3);
    expect(result.redundant).toBe(0);
  });

  it('names a circle by its radius', () => {
    const sketch = inferCircle({ u: 5, v: 7 }, 12);
    expect(dimensionsOf(sketch)).toEqual(['centreU', 'centreV', 'radius']);

    const result = solveSketch(
      sketch,
      new Map([
        ['centreU', 5],
        ['centreV', 7],
        ['radius', 3],
      ]),
    );
    expect(result.solved).toBe(true);
    expect(result.freedom).toBe(0);
    expect(result.radii[0]).toBeCloseTo(3, 9);
  });
});
