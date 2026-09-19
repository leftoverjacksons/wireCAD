import ocFactory from 'opencascade.js/dist/opencascade.wasm.js';
import wasmUrl from 'opencascade.js/dist/opencascade.wasm.wasm?url';
import type { CacheEntry } from '../core/cache.js';
import type { GeometryRef, PlaneValue, Value, Vec3 } from '../core/types.js';

export interface OpenCascadeInstance {
  [key: string]: any;
}

export interface Shape {
  delete?: () => void;
  [key: string]: any;
}

export interface FaceInfo {
  /** Centroid of the tessellated face, area-weighted. */
  origin: Vec3;
  /**
   * The centroid as a fraction of the body's bounding box.
   *
   * The same trick the edges use, and for the same reason: absolute positions
   * move when a parameter changes, but a face keeps its place in the box. It is
   * what lets a face be named without a normal, which a bore or a rounding has
   * no single one of.
   */
  fraction: Vec3;
  /** Outward normal, area-weighted; meaningful when `planar`. */
  normal: Vec3;
  area: number;
  planar: boolean;
  /** Triangles for one face are contiguous, so this doubles as a render group. */
  triangleStart: number;
  triangleCount: number;
}

export interface EdgeInfo {
  /** Midpoint by arc length, in model units. */
  midpoint: Vec3;
  /**
   * The midpoint as a fraction of the body's bounding box. Absolute positions
   * move when a parameter changes, but an edge keeps its place in the box, so
   * this is what a stored reference is matched on.
   */
  fraction: Vec3;
  /** Chord direction, sign-canonicalised so a reversed edge reads the same. */
  direction: Vec3;
  length: number;
  /** Segments for one edge are contiguous, so this doubles as a render group. */
  segmentStart: number;
  segmentCount: number;
}

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Owning face ordinal per triangle. */
  faceIds: Uint32Array;
  faces: FaceInfo[];
  /** Two vertices per segment, laid out for THREE.LineSegments. */
  edgePositions: Float32Array;
  /** Owning edge ordinal per segment. */
  edgeIds: Uint32Array;
  edges: EdgeInfo[];
}

export interface Tessellation {
  /** Transferable: everything here survives structured cloning. */
  mesh: MeshBuffers;
  /** Kernel faces, parallel to `mesh.faces`. Cannot cross a worker boundary. */
  faceHandles: Shape[];
  /** Kernel edges, parallel to `mesh.edges`. Cannot cross a worker boundary. */
  edgeHandles: Shape[];
}

let cached: OpenCascadeInstance | null = null;

export async function loadKernel(): Promise<OpenCascadeInstance> {
  if (cached !== null) return cached;
  cached = (await ocFactory({ locateFile: () => wasmUrl })) as OpenCascadeInstance;
  return cached;
}

export function geometry(
  shape: Shape,
  plane?: PlaneValue,
  newFaces?: readonly Shape[],
): GeometryRef {
  return {
    kind: 'geometry',
    handle: shape,
    ...(plane === undefined ? {} : { plane }),
    ...(newFaces === undefined || newFaces.length === 0 ? {} : { newFaces }),
  };
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

/**
 * OpenCASCADE's C++ exceptions do not survive this Emscripten build: a rejected
 * operation surfaces as an internal artefact such as "wasmTable.get(...) is not
 * a function" rather than a reason. Name the operation and offer the likely
 * cause instead of showing the reader something meaningless.
 */
export function kernelCall<T>(operation: string, likelyCause: string, fn: () => T): T {
  try {
    return fn();
  } catch (thrown) {
    const detail = thrown instanceof Error ? thrown.message : String(thrown);
    const internal = /wasmTable|__cxa|is not a function|is not defined|memory access/i.test(detail);
    throw new Error(internal ? `${operation} failed — ${likelyCause}` : `${operation} failed: ${detail}`);
  }
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

  // Sub-shape handles are wrappers of their own: freeing the body does not free
  // them, and nothing else will.
  for (const face of value.newFaces ?? []) (face as { delete?: () => void })?.delete?.();
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
): Tessellation {
  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, angular, false);

  const positions: number[] = [];
  const indices: number[] = [];
  const faceIds: number[] = [];
  const faces: FaceInfo[] = [];
  const faceHandles: Shape[] = [];
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
      const triangleStart = indices.length / 3;

      const nodeCount = triangulation.NbNodes();
      for (let i = 1; i <= nodeCount; i++) {
        const point = triangulation.Node(i).Transformed(transform);
        positions.push(point.X(), point.Y(), point.Z());
      }

      const triangleCount = triangulation.NbTriangles();
      const ordinal = faces.length;
      for (let i = 1; i <= triangleCount; i++) {
        const triangle = triangulation.Triangle(i);
        const a = base + triangle.Value(1) - 1;
        const b = base + triangle.Value(2) - 1;
        const c = base + triangle.Value(3) - 1;
        if (reversed) indices.push(a, c, b);
        else indices.push(a, b, c);
        faceIds.push(ordinal);
      }

      const emitted = indices.length / 3 - triangleStart;
      if (emitted > 0) {
        faces.push(summariseFace(positions, indices, triangleStart, emitted));
        faceHandles.push(face);
      }
    }

    location.delete();
    explorer.Next();
  }

  explorer.delete();
  mesher.delete?.();

  // Known only once every face has been tessellated, and needed by both.
  const bounds = boundsOf(positions);
  for (const [index, face] of faces.entries()) {
    faces[index] = {
      ...face,
      fraction: {
        x: (face.origin.x - bounds.min.x) / bounds.size.x,
        y: (face.origin.y - bounds.min.y) / bounds.size.y,
        z: (face.origin.z - bounds.min.z) / bounds.size.z,
      },
    };
  }

  const { edgePositions, edgeIds, edges, edgeHandles } = tessellateEdges(
    oc,
    shape,
    bounds,
    angular,
    deflection,
  );

  return {
    mesh: {
      positions: new Float32Array(positions),
      normals: computeNormals(positions, indices),
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
      faces,
      edgePositions,
      edgeIds,
      edges,
    },
    faceHandles,
    edgeHandles,
  };
}

interface Bounds {
  min: Vec3;
  size: Vec3;
}

function boundsOf(positions: number[]): Bounds {
  if (positions.length === 0) {
    return { min: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!);
    maxX = Math.max(maxX, positions[i]!);
    maxY = Math.max(maxY, positions[i + 1]!);
    maxZ = Math.max(maxZ, positions[i + 2]!);
  }

  // A flat body has a zero extent on one axis; keep the divisor non-zero so the
  // fraction stays finite rather than becoming NaN.
  return {
    min: { x: minX, y: minY, z: minZ },
    size: {
      x: Math.max(maxX - minX, 1e-9),
      y: Math.max(maxY - minY, 1e-9),
      z: Math.max(maxZ - minZ, 1e-9),
    },
  };
}

/**
 * Walks the shape's edges and samples each into a polyline. Sampling comes from
 * the curve itself rather than from the face triangulation, so a circular edge
 * stays smooth at whatever deflection the faces were meshed with.
 */
function tessellateEdges(
  oc: OpenCascadeInstance,
  shape: Shape,
  bounds: Bounds,
  angular: number,
  deflection: number,
): {
  edgePositions: Float32Array;
  edgeIds: Uint32Array;
  edges: EdgeInfo[];
  edgeHandles: Shape[];
} {
  const edgePositions: number[] = [];
  const edgeIds: number[] = [];
  const edges: EdgeInfo[] = [];
  const edgeHandles: Shape[] = [];
  const seen: Shape[] = [];

  const explorer = new oc.TopExp_Explorer_2(
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  while (explorer.More()) {
    const edge = oc.TopoDS.Edge_1(explorer.Current());
    explorer.Next();

    // The explorer visits an edge once per adjoining face; a seam or degenerate
    // edge is not something anyone can click on, so drop both.
    if (seen.some((other) => other.IsSame(edge))) continue;
    seen.push(edge);
    if (oc.BRep_Tool.Degenerated(edge)) continue;

    const sampled = samplePoints(oc, edge, angular, deflection);
    if (sampled.length < 2) continue;

    const ordinal = edges.length;
    const segmentStart = edgeIds.length;
    for (let i = 0; i + 1 < sampled.length; i++) {
      const a = sampled[i]!;
      const b = sampled[i + 1]!;
      edgePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      edgeIds.push(ordinal);
    }

    const segmentCount = edgeIds.length - segmentStart;
    if (segmentCount === 0) continue;

    edges.push({
      ...describeEdge(oc, edge, sampled, bounds),
      segmentStart,
      segmentCount,
    });
    edgeHandles.push(edge);
  }

  explorer.delete();

  return {
    edgePositions: new Float32Array(edgePositions),
    edgeIds: new Uint32Array(edgeIds),
    edges,
    edgeHandles,
  };
}

function samplePoints(
  oc: OpenCascadeInstance,
  edge: Shape,
  angular: number,
  deflection: number,
): Vec3[] {
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  const points: Vec3[] = [];
  try {
    const sampler = new oc.GCPnts_TangentialDeflection_2(
      curve,
      angular,
      deflection,
      2,
      1.0e-7,
      1.0e-7,
    );
    const count = sampler.NbPoints();
    for (let i = 1; i <= count; i++) {
      const point = sampler.Value(i);
      points.push({ x: point.X(), y: point.Y(), z: point.Z() });
    }
    sampler.delete?.();
  } catch {
    // An edge with no usable curve is not pickable; leave it out rather than
    // failing the whole tessellation.
    return [];
  } finally {
    curve.delete?.();
  }
  return points;
}

function describeEdge(
  oc: OpenCascadeInstance,
  edge: Shape,
  sampled: Vec3[],
  bounds: Bounds,
): Omit<EdgeInfo, 'segmentStart' | 'segmentCount'> {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.LinearProperties(edge, props, false, false);
  const centre = props.CentreOfMass();
  const midpoint: Vec3 = { x: centre.X(), y: centre.Y(), z: centre.Z() };
  const length = props.Mass();
  props.delete?.();

  const first = sampled[0]!;
  const last = sampled[sampled.length - 1]!;
  return {
    midpoint,
    fraction: {
      x: (midpoint.x - bounds.min.x) / bounds.size.x,
      y: (midpoint.y - bounds.min.y) / bounds.size.y,
      z: (midpoint.z - bounds.min.z) / bounds.size.z,
    },
    direction: canonicalDirection(first, last),
    length,
  };
}

/**
 * The chord direction, flipped to a fixed sign so that an edge and its reverse
 * describe themselves identically. A closed edge has no chord and reports zero,
 * which the matcher reads as "position only".
 */
function canonicalDirection(from: Vec3, to: Vec3): Vec3 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const magnitude = Math.hypot(dx, dy, dz);
  if (magnitude < 1e-9) return { x: 0, y: 0, z: 0 };

  const sign =
    Math.abs(dx) > 1e-9 ? Math.sign(dx) : Math.abs(dy) > 1e-9 ? Math.sign(dy) : Math.sign(dz);
  const flip = sign < 0 ? -1 : 1;
  return { x: (dx / magnitude) * flip, y: (dy / magnitude) * flip, z: (dz / magnitude) * flip };
}

/** Area-weighted centroid and normal, plus how flat the face actually is. */
function summariseFace(
  positions: number[],
  indices: number[],
  triangleStart: number,
  triangleCount: number,
): FaceInfo {
  let totalArea = 0;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  let centroidX = 0;
  let centroidY = 0;
  let centroidZ = 0;

  const end = triangleStart + triangleCount;
  for (let t = triangleStart; t < end; t++) {
    const ia = indices[t * 3]! * 3;
    const ib = indices[t * 3 + 1]! * 3;
    const ic = indices[t * 3 + 2]! * 3;

    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const ux = positions[ib]! - ax;
    const uy = positions[ib + 1]! - ay;
    const uz = positions[ib + 2]! - az;
    const vx = positions[ic]! - ax;
    const vy = positions[ic + 1]! - ay;
    const vz = positions[ic + 2]! - az;

    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const area = Math.hypot(cx, cy, cz) / 2;

    totalArea += area;
    sumX += cx;
    sumY += cy;
    sumZ += cz;
    centroidX += (area * (ax + positions[ib]! + positions[ic]!)) / 3;
    centroidY += (area * (ay + positions[ib + 1]! + positions[ic + 1]!)) / 3;
    centroidZ += (area * (az + positions[ib + 2]! + positions[ic + 2]!)) / 3;
  }

  const magnitude = Math.hypot(sumX, sumY, sumZ);
  const normal: Vec3 =
    magnitude === 0
      ? { x: 0, y: 0, z: 0 }
      : { x: sumX / magnitude, y: sumY / magnitude, z: sumZ / magnitude };

  const origin: Vec3 =
    totalArea === 0
      ? { x: 0, y: 0, z: 0 }
      : { x: centroidX / totalArea, y: centroidY / totalArea, z: centroidZ / totalArea };

  return {
    origin,
    // Filled in once every face is meshed and the body's extent is known.
    fraction: { x: 0, y: 0, z: 0 },
    normal,
    area: totalArea,
    planar: isPlanar(positions, indices, triangleStart, triangleCount, normal),
    triangleStart,
    triangleCount,
  };
}

function isPlanar(
  positions: number[],
  indices: number[],
  triangleStart: number,
  triangleCount: number,
  normal: Vec3,
): boolean {
  const end = triangleStart + triangleCount;
  for (let t = triangleStart; t < end; t++) {
    const ia = indices[t * 3]! * 3;
    const ib = indices[t * 3 + 1]! * 3;
    const ic = indices[t * 3 + 2]! * 3;

    const ax = positions[ia]!;
    const ay = positions[ia + 1]!;
    const az = positions[ia + 2]!;
    const ux = positions[ib]! - ax;
    const uy = positions[ib + 1]! - ay;
    const uz = positions[ib + 2]! - az;
    const vx = positions[ic]! - ax;
    const vy = positions[ic + 1]! - ay;
    const vz = positions[ic + 2]! - az;

    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const magnitude = Math.hypot(cx, cy, cz);
    if (magnitude === 0) continue;

    const alignment = (cx * normal.x + cy * normal.y + cz * normal.z) / magnitude;
    if (alignment < 0.9995) return false;
  }
  return true;
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
