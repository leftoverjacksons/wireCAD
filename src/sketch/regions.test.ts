import { describe, expect, it } from 'vitest';
import type { Sketch } from './model.js';
import { nestRegions, regionsOf, signedArea } from './regions.js';

function box(u: number, v: number, size: number): { points: Array<{ u: number; v: number }> } {
  return {
    points: [
      { u, v },
      { u: u + size, v },
      { u: u + size, v: v + size },
      { u, v: v + size },
    ],
  };
}

function loop(sketch: Sketch, first: number, count: number): void {
  for (let i = 0; i < count; i++) {
    sketch.entities.push({ kind: 'line', a: first + i, b: first + ((i + 1) % count) });
  }
}

describe('regionsOf', () => {
  it('finds one loop in a closed rectangle', () => {
    const sketch: Sketch = { points: box(0, 0, 10).points, entities: [], constraints: [] };
    loop(sketch, 0, 4);

    const regions = regionsOf(sketch);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ kind: 'loop', points: [0, 1, 2, 3] });
  });

  it('finds two loops drawn one inside the other', () => {
    const sketch: Sketch = {
      points: [...box(0, 0, 40).points, ...box(10, 10, 10).points],
      entities: [],
      constraints: [],
    };
    loop(sketch, 0, 4);
    loop(sketch, 4, 4);

    expect(regionsOf(sketch)).toHaveLength(2);
  });

  it('counts each circle as a region of its own', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }, { u: 30, v: 0 }],
      entities: [
        { kind: 'circle', centre: 0, radius: 5 },
        { kind: 'circle', centre: 1, radius: 5 },
      ],
      constraints: [],
    };

    expect(regionsOf(sketch).map((region) => region.kind)).toEqual(['circle', 'circle']);
  });

  it('refuses a loose end rather than guessing how to close it', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }, { u: 10, v: 0 }, { u: 10, v: 10 }],
      entities: [
        { kind: 'line', a: 0, b: 1 },
        { kind: 'line', a: 1, b: 2 },
      ],
      constraints: [],
    };

    expect(() => regionsOf(sketch)).toThrow(/loose end/);
  });

  it('leaves a construction line out of the profile it crosses', () => {
    const sketch: Sketch = { points: box(0, 0, 10).points, entities: [], constraints: [] };
    loop(sketch, 0, 4);
    // A diagonal corner to corner: it would branch the loop at both ends if the
    // profile were built from it.
    sketch.entities.push({ kind: 'line', a: 0, b: 2, construction: true });

    const regions = regionsOf(sketch);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ kind: 'loop', entities: [0, 1, 2, 3] });
  });

  it('lets a construction line hang off the drawing without a loose end', () => {
    const sketch: Sketch = { points: box(0, 0, 10).points, entities: [], constraints: [] };
    loop(sketch, 0, 4);
    sketch.points.push({ u: 25, v: 5 });
    sketch.entities.push({ kind: 'line', a: 1, b: 4, construction: true });

    expect(regionsOf(sketch)).toHaveLength(1);
  });

  it('leaves a construction circle out, so it is no hole in what holds it', () => {
    const sketch: Sketch = {
      points: [...box(0, 0, 40).points, { u: 20, v: 20 }],
      entities: [],
      constraints: [],
    };
    loop(sketch, 0, 4);
    // The circle holes would be spaced around, rather than a hole itself.
    sketch.entities.push({ kind: 'circle', centre: 4, radius: 12, construction: true });

    const regions = regionsOf(sketch);
    expect(regions).toHaveLength(1);
    expect(nestRegions(regions, sketch.points, [0, 0, 0, 0, 12])[0]!.holes).toEqual([]);
  });

  it('finds nothing closed in a sketch that is all construction', () => {
    const sketch: Sketch = { points: box(0, 0, 10).points, entities: [], constraints: [] };
    loop(sketch, 0, 4);
    for (const entity of sketch.entities) {
      if (entity.kind === 'line') entity.construction = true;
    }

    expect(regionsOf(sketch)).toEqual([]);
  });

  it('refuses a point where three edges meet', () => {
    const sketch: Sketch = { points: box(0, 0, 10).points, entities: [], constraints: [] };
    loop(sketch, 0, 4);
    sketch.points.push({ u: 20, v: 20 });
    sketch.entities.push({ kind: 'line', a: 0, b: 4 });

    expect(() => regionsOf(sketch)).toThrow(/cannot branch/);
  });
});

describe('nestRegions', () => {
  it('makes an inner circle a hole in the loop around it', () => {
    const sketch: Sketch = {
      points: [...box(0, 0, 40).points, { u: 20, v: 20 }],
      entities: [],
      constraints: [],
    };
    loop(sketch, 0, 4);
    sketch.entities.push({ kind: 'circle', centre: 4, radius: 5 });

    const regions = regionsOf(sketch);
    const faces = nestRegions(regions, sketch.points, [0, 0, 0, 0, 5]);

    expect(faces).toHaveLength(1);
    expect(regions[faces[0]!.outer]!.kind).toBe('loop');
    expect(faces[0]!.holes.map((index) => regions[index]!.kind)).toEqual(['circle']);
  });

  it('leaves side by side circles as two faces', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }, { u: 30, v: 0 }],
      entities: [
        { kind: 'circle', centre: 0, radius: 5 },
        { kind: 'circle', centre: 1, radius: 5 },
      ],
      constraints: [],
    };

    const faces = nestRegions(regionsOf(sketch), sketch.points, [5, 5]);
    expect(faces).toHaveLength(2);
    expect(faces.every((face) => face.holes.length === 0)).toBe(true);
  });

  it('makes a loop inside a hole solid again', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }],
      entities: [
        { kind: 'circle', centre: 0, radius: 30 },
        { kind: 'circle', centre: 1, radius: 20 },
        { kind: 'circle', centre: 2, radius: 10 },
      ],
      constraints: [],
    };

    const regions = regionsOf(sketch);
    const faces = nestRegions(regions, sketch.points, [30, 20, 10]);

    // Outer disc with the middle ring cut out, and the innermost disc standing
    // alone inside it.
    expect(faces).toHaveLength(2);
    expect(faces[0]).toMatchObject({ outer: 0, holes: [1] });
    expect(faces[1]).toMatchObject({ outer: 2, holes: [] });
  });
});

describe('signedArea', () => {
  it('reads positive one way round and negative the other', () => {
    const square = box(0, 0, 10).points;
    expect(signedArea(square)).toBeGreaterThan(0);
    expect(signedArea([...square].reverse())).toBeLessThan(0);
  });

  it('does not depend on where the loop starts', () => {
    const square = box(0, 0, 10).points;
    const rotated = [...square.slice(2), ...square.slice(0, 2)];
    expect(signedArea(rotated)).toBeCloseTo(signedArea(square), 9);
  });
});
