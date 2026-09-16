import { describe, expect, it } from 'vitest';
import type { MeshBuffers } from './kernel.js';
import { writeBinaryStl } from './stl.js';

function triangleMesh(): MeshBuffers {
  return {
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    faceIds: new Uint32Array([0]),
    faces: [],
  };
}

describe('writeBinaryStl', () => {
  it('uses the binary layout of 84 bytes plus 50 per triangle', () => {
    const bytes = writeBinaryStl(triangleMesh());
    expect(bytes.byteLength).toBe(84 + 50);

    const view = new DataView(bytes.buffer);
    expect(view.getUint32(80, true)).toBe(1);
  });

  it('writes the facet normal and vertices in order', () => {
    const bytes = writeBinaryStl(triangleMesh());
    const view = new DataView(bytes.buffer);
    const read = (index: number): number => view.getFloat32(84 + index * 4, true);

    // Counter-clockwise in the XY plane, so the facet faces +Z.
    expect([read(0), read(1), read(2)]).toEqual([0, 0, 1]);
    expect([read(3), read(4), read(5)]).toEqual([0, 0, 0]);
    expect([read(6), read(7), read(8)]).toEqual([2, 0, 0]);
    expect([read(9), read(10), read(11)]).toEqual([0, 3, 0]);
    expect(view.getUint16(84 + 48, true)).toBe(0);
  });

  it('writes every triangle it is given', () => {
    const mesh = triangleMesh();
    const many: MeshBuffers = {
      ...mesh,
      indices: new Uint32Array([0, 1, 2, 2, 1, 0]),
      faceIds: new Uint32Array([0, 0]),
    };

    const bytes = writeBinaryStl(many);
    const view = new DataView(bytes.buffer);

    expect(view.getUint32(80, true)).toBe(2);
    expect(bytes.byteLength).toBe(84 + 100);
    // The second record starts one 50-byte triangle in; its reversed winding
    // must flip the facet normal.
    expect(view.getFloat32(84 + 50 + 8, true)).toBe(-1);
  });

  it('produces a header that identifies the writer', () => {
    const bytes = writeBinaryStl(triangleMesh());
    const header = new TextDecoder().decode(bytes.slice(0, 18));
    expect(header).toBe('wireCAD binary STL');
  });
});
