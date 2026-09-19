import { describe, expect, it } from 'vitest';
import type { Sketch } from './model.js';
import { decodeSketch, encodeSketch } from './model.js';

function roundtrip(sketch: Sketch): Sketch {
  const encoded = encodeSketch(sketch);
  return decodeSketch(encoded.points, encoded.entities, encoded.constraints);
}

describe('storing a sketch', () => {
  it('keeps a construction line construction', () => {
    const sketch: Sketch = {
      points: [
        { u: 0, v: 0 },
        { u: 40, v: 0 },
        { u: 40, v: 25 },
      ],
      entities: [
        { kind: 'line', a: 0, b: 1 },
        { kind: 'line', a: 0, b: 2, construction: true },
      ],
      constraints: [{ kind: 'distance', a: 0, b: 2, dimension: 'diagonal' }],
    };

    expect(roundtrip(sketch)).toEqual(sketch);
  });

  it('keeps a construction circle construction', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }],
      entities: [{ kind: 'circle', centre: 0, radius: 20, construction: true }],
      constraints: [{ kind: 'radius', circle: 0, dimension: 'pitch' }],
    };

    expect(roundtrip(sketch)).toEqual(sketch);
    expect(encodeSketch(sketch).entities).toEqual([['circle', 0, 20, 1]]);
  });

  it('writes nothing extra for an ordinary line', () => {
    const sketch: Sketch = {
      points: [{ u: 0, v: 0 }, { u: 10, v: 0 }],
      entities: [{ kind: 'line', a: 0, b: 1 }],
      constraints: [],
    };

    // A document written before construction lines existed reads back as what
    // it was, and one written now is no longer than it was.
    expect(encodeSketch(sketch).entities).toEqual([['line', 0, 1]]);
    expect(roundtrip(sketch).entities[0]).not.toHaveProperty('construction');
  });

  it('reads entities written without the flag as ordinary ones', () => {
    const sketch = decodeSketch([0, 0, 10, 0], [['line', 0, 1], ['circle', 0, 4]], []);
    expect(sketch.entities).toEqual([
      { kind: 'line', a: 0, b: 1 },
      { kind: 'circle', centre: 0, radius: 4 },
    ]);
  });

  it('refuses a flag that is neither on nor off', () => {
    expect(() => decodeSketch([0, 0, 10, 0], [['line', 0, 1, 'yes']], [])).toThrow(/flag/);
  });
});
