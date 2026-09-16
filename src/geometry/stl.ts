import type { MeshBuffers } from './kernel.js';

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

/**
 * Binary STL from an already-tessellated mesh. Written directly rather than
 * through the kernel's writer, so the deflection used for export is ours to
 * choose and there is no virtual-filesystem round trip.
 */
export function writeBinaryStl(mesh: MeshBuffers): Uint8Array<ArrayBuffer> {
  const triangles = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangles * TRIANGLE_BYTES);
  const view = new DataView(buffer);

  const header = 'wireCAD binary STL';
  for (let i = 0; i < header.length && i < HEADER_BYTES; i++) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(HEADER_BYTES, triangles, true);

  let offset = HEADER_BYTES + 4;
  for (let t = 0; t < triangles; t++) {
    const ia = mesh.indices[t * 3]! * 3;
    const ib = mesh.indices[t * 3 + 1]! * 3;
    const ic = mesh.indices[t * 3 + 2]! * 3;

    const ax = mesh.positions[ia]!;
    const ay = mesh.positions[ia + 1]!;
    const az = mesh.positions[ia + 2]!;
    const bx = mesh.positions[ib]!;
    const by = mesh.positions[ib + 1]!;
    const bz = mesh.positions[ib + 2]!;
    const cx = mesh.positions[ic]!;
    const cy = mesh.positions[ic + 1]!;
    const cz = mesh.positions[ic + 2]!;

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const magnitude = Math.hypot(nx, ny, nz);
    if (magnitude > 0) {
      nx /= magnitude;
      ny /= magnitude;
      nz /= magnitude;
    }

    for (const component of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}
