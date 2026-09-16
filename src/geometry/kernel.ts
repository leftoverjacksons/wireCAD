import ocFactory from 'opencascade.js/dist/opencascade.wasm.js';
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url';
import type { CacheEntry } from '../core/cache.js';
import type { GeometryRef, PlaneValue, Value } from '../core/types.js';

export interface OpenCascadeInstance {
  [key: string]: any;
}

export interface Shape {
  delete?: () => void;
  [key: string]: any;
}

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

let cached: OpenCascadeInstance | null = null;

export async function loadKernel(): Promise<OpenCascadeInstance> {
  if (cached !== null) return cached;
  cached = (await ocFactory({ locateFile: () => wasmUrl })) as OpenCascadeInstance;
  return cached;
}

export function geometry(shape: Shape, plane?: PlaneValue): GeometryRef {
  return plane === undefined
    ? { kind: 'geometry', handle: shape }
    : { kind: 'geometry', handle: shape, plane };
}

export function isGeometry(value: Value): value is GeometryRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'kind' in value &&
    (value as GeometryRef).kind === 'geometry'
  );
}

export function geometryOf(value: Value, portId: string): GeometryRef {
  if (!isGeometry(value)) {
    throw new Error(`Input "${portId}" expects geometry`);
  }
  return value;
}

export function shapeOf(value: Value, portId: string): Shape {
  return geometryOf(value, portId).handle as Shape;
}

function disposeValue(value: Value): void {
  if (Array.isArray(value)) {
    for (const item of value) disposeValue(item);
    return;
  }
  if (!isGeometry(value)) return;
  const handle = value.handle as { delete?: () => void } | null;
  handle?.delete?.();
}

/** Kernel shapes live in the WASM heap and are not reclaimed by the JS GC. */
export function disposeCacheEntry(entry: CacheEntry): void {
  if (entry.outputs === null) return;
  for (const value of Object.values(entry.outputs)) disposeValue(value);
}

export function tessellate(
  oc: OpenCascadeInstance,
  shape: Shape,
  deflection = 0.05,
  angular = 0.3,
): MeshBuffers {
  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angular, false);

  const positions: number[] = [];
  const indices: number[] = [];
  const reversedFlag = oc.TopAbs_Orientation.TopAbs_REVERSED.value;

  const explorer = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  while (explorer.More()) {
    const face = oc.TopoDS.Face_1(explorer.Current());
    const location = new oc.TopLoc_Location_1();
    const handle = oc.BRep_Tool.Triangulation(face, location);

    if (!handle.IsNull()) {
      const triangulation = handle.get();
      const transform = location.Transformation();
      const reversed = face.Orientation_1().value === reversedFlag;
      const base = positions.length / 3;

      const nodeCount = triangulation.NbNodes();
      for (let i = 1; i <= nodeCount; i++) {
        const point = triangulation.Node(i).Transformed(transform);
        positions.push(point.X(), point.Y(), point.Z());
      }

      const triangleCount = triangulation.NbTriangles();
      for (let i = 1; i <= triangleCount; i++) {
        const triangle = triangulation.Triangle(i);
        const a = base + triangle.Value(1) - 1;
        const b = base + triangle.Value(2) - 1;
        const c = base + triangle.Value(3) - 1;
        if (reversed) indices.push(a, c, b);
        else indices.push(a, b, c);
      }
    }

    location.delete();
    explorer.Next();
  }

  explorer.delete();
  mesher.delete?.();

  return {
    positions: new Float32Array(positions),
    normals: computeNormals(positions, indices),
    indices: new Uint32Array(indices),
  };
}

function computeNormals(positions: number[], indices: number[]): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]! * 3;
    const ib = indices[i + 1]! * 3;
    const ic = indices[i + 2]! * 3;

    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const ux = positions[ib]! - ax;
    const uy = positions[ib + 1]! - ay;
    const uz = positions[ib + 2]! - az;
    const vx = positions[ic]! - ax;
    const vy = positions[ic + 1]! - ay;
    const vz = positions[ic + 2]! - az;

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;

    for (const offset of [ia, ib, ic]) {
      normals[offset] = normals[offset]! + nx;
      normals[offset + 1] = normals[offset + 1]! + ny;
      normals[offset + 2] = normals[offset + 2]! + nz;
    }
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i]!;
    const y = normals[i + 1]!;
    const z = normals[i + 2]!;
    const length = Math.hypot(x, y, z);
    if (length > 0) {
      normals[i] = x / length;
      normals[i + 1] = y / length;
      normals[i + 2] = z / length;
    }
  }

  return normals;
}
