import { describe, expect, it } from 'vitest';
import type { FaceInfo } from '../geometry/kernel.js';
import { matchFaceRef } from './faceref.js';

function face(fraction: { x: number; y: number; z: number }, area: number): FaceInfo {
  return {
    origin: { x: 0, y: 0, z: 0 },
    fraction,
    normal: { x: 0, y: 0, z: 1 },
    area,
    planar: false,
    triangleStart: 0,
    triangleCount: 2,
  };
}

/** A block with a bore through the middle and a small boss near one corner. */
const faces: FaceInfo[] = [
  face({ x: 0.5, y: 0.5, z: 1 }, 2400),
  face({ x: 0.5, y: 0.5, z: 0.5 }, 1000),
  face({ x: 0.2, y: 0.2, z: 1 }, 60),
  face({ x: 0, y: 0.5, z: 0.5 }, 800),
];

describe('naming a face by where it sits', () => {
  it('finds the one it was taken from', () => {
    expect(matchFaceRef(faces, { fx: 0.5, fy: 0.5, fz: 0.5, area: 1000 })).toBe(1);
    expect(matchFaceRef(faces, { fx: 0.2, fy: 0.2, fz: 1, area: 60 })).toBe(2);
  });

  it('follows a face whose body was resized', () => {
    // The fraction is what does not move: the bore is still in the middle.
    expect(matchFaceRef(faces, { fx: 0.51, fy: 0.49, fz: 0.5, area: 1400 })).toBe(1);
  });

  it('tells apart two faces that share a place', () => {
    // A small boss sitting on a large top: the same spot, different sizes.
    const stacked = [face({ x: 0.5, y: 0.5, z: 1 }, 2400), face({ x: 0.5, y: 0.5, z: 1 }, 50)];
    expect(matchFaceRef(stacked, { fx: 0.5, fy: 0.5, fz: 1, area: 48 })).toBe(1);
    expect(matchFaceRef(stacked, { fx: 0.5, fy: 0.5, fz: 1, area: 2300 })).toBe(0);
  });

  it('refuses rather than guessing when nothing is near', () => {
    expect(matchFaceRef(faces, { fx: 0.9, fy: 0.9, fz: 0.1, area: 1000 })).toBe(-1);
  });

  it('refuses on a body with no faces at all', () => {
    expect(matchFaceRef([], { fx: 0.5, fy: 0.5, fz: 0.5, area: 100 })).toBe(-1);
  });
});
