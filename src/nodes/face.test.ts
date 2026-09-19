import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types.js';
import type { FaceInfo } from '../geometry/kernel.js';
import { matchingFaces } from './face.js';

function face(normal: Vec3, origin: Vec3, options: Partial<FaceInfo> = {}): FaceInfo {
  return {
    origin,
    fraction: { x: 0.5, y: 0.5, z: 0.5 },
    normal,
    area: 100,
    planar: true,
    triangleStart: 0,
    triangleCount: 2,
    ...options,
  };
}

const UP: Vec3 = { x: 0, y: 0, z: 1 };

/** The six faces of an axis-aligned box of the given height. */
function box(height: number): FaceInfo[] {
  return [
    face({ x: 0, y: 0, z: 1 }, { x: 30, y: 20, z: height }),
    face({ x: 0, y: 0, z: -1 }, { x: 30, y: 20, z: 0 }),
    face({ x: 1, y: 0, z: 0 }, { x: 60, y: 20, z: height / 2 }),
    face({ x: -1, y: 0, z: 0 }, { x: 0, y: 20, z: height / 2 }),
    face({ x: 0, y: 1, z: 0 }, { x: 30, y: 40, z: height / 2 }),
    face({ x: 0, y: -1, z: 0 }, { x: 30, y: 0, z: height / 2 }),
  ];
}

describe('matchingFaces', () => {
  it('finds the single upward face of a box', () => {
    const matches = matchingFaces(box(20), UP);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.face.origin.z).toBe(20);
  });

  it('keeps pointing at the top after the box is resized', () => {
    const before = matchingFaces(box(20), UP)[0];
    const after = matchingFaces(box(55), UP)[0];
    expect(before?.face.origin.z).toBe(20);
    expect(after?.face.origin.z).toBe(55);
  });

  it('orders co-directional faces from furthest along the normal', () => {
    const withBoss = [...box(20), face(UP, { x: 30, y: 20, z: 34 })];
    const matches = matchingFaces(withBoss, UP);

    expect(matches.map((match) => match.face.origin.z)).toEqual([34, 20]);
  });

  it('keeps rank stable when both surfaces move', () => {
    const shallow = matchingFaces([...box(20), face(UP, { x: 30, y: 20, z: 34 })], UP);
    const tall = matchingFaces([...box(30), face(UP, { x: 30, y: 20, z: 48 })], UP);

    // Rank 1 is the box top in both, even though every z changed.
    expect(shallow[1]?.face.origin.z).toBe(20);
    expect(tall[1]?.face.origin.z).toBe(30);
  });

  it('ignores faces pointing elsewhere', () => {
    expect(matchingFaces(box(20), { x: 1, y: 0, z: 0 })).toHaveLength(1);
    expect(matchingFaces(box(20), { x: 0, y: 0, z: -1 })[0]?.face.origin.z).toBe(0);
  });

  it('ignores curved and degenerate faces', () => {
    const faces = [
      face(UP, { x: 0, y: 0, z: 9 }, { planar: false }),
      face(UP, { x: 0, y: 0, z: 8 }, { area: 0 }),
      face(UP, { x: 0, y: 0, z: 7 }),
    ];
    const matches = matchingFaces(faces, UP);

    expect(matches).toHaveLength(1);
    expect(matches[0]?.face.origin.z).toBe(7);
  });

  it('tolerates small normal deviation but rejects a tilted face', () => {
    const wobble = Math.sin(0.03);
    const nearlyUp = face({ x: wobble, y: 0, z: Math.cos(0.03) }, { x: 0, y: 0, z: 5 });
    const tilted = face({ x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, { x: 0, y: 0, z: 6 });

    expect(matchingFaces([nearlyUp], UP)).toHaveLength(1);
    expect(matchingFaces([tilted], UP)).toHaveLength(0);
  });
});
