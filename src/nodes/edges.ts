import type { NodeDefinition, NodeSchema, Vec3 } from '../core/types.js';
import type { EdgeInfo, OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { tessellate } from '../geometry/kernel.js';
import { asList } from './coerce.js';

/** Seven numbers per edge: fraction x/y/z, direction x/y/z, length. */
export const EDGE_STRIDE = 7;

export interface EdgeRef {
  fraction: Vec3;
  direction: Vec3;
  length: number;
}

/**
 * A stored selection of edges. It holds no kernel handles — those cannot outlive
 * the shape they came from — only the descriptors, which the operation using
 * them re-resolves against its own input on every solve.
 */
export const edgeSelectionSchema: NodeSchema = {
  type: 'edge.selection',
  label: 'Edge Selection',
  category: 'Select',
  inputs: [{ id: 'refs', label: 'Edges', type: 'edges', default: [] }],
  outputs: [{ id: 'edges', label: 'Edges', type: 'edges' }],
};

export const edgeSchemas: readonly NodeSchema[] = [edgeSelectionSchema];

export function packEdgeRefs(refs: readonly EdgeRef[]): number[] {
  const packed: number[] = [];
  for (const ref of refs) {
    packed.push(
      ref.fraction.x,
      ref.fraction.y,
      ref.fraction.z,
      ref.direction.x,
      ref.direction.y,
      ref.direction.z,
      ref.length,
    );
  }
  return packed;
}

export function unpackEdgeRefs(values: readonly number[]): EdgeRef[] {
  if (values.length % EDGE_STRIDE !== 0) {
    throw new Error(`An edge selection needs ${EDGE_STRIDE} numbers per edge`);
  }

  const refs: EdgeRef[] = [];
  for (let i = 0; i < values.length; i += EDGE_STRIDE) {
    refs.push({
      fraction: { x: values[i]!, y: values[i + 1]!, z: values[i + 2]! },
      direction: { x: values[i + 3]!, y: values[i + 4]!, z: values[i + 5]! },
      length: values[i + 6]!,
    });
  }
  return refs;
}

export function edgeRefOf(edge: EdgeInfo): EdgeRef {
  return { fraction: edge.fraction, direction: edge.direction, length: edge.length };
}

/** Numbers straight off a port, validated into edge references. */
export function readEdgeRefs(value: unknown, portId: string): EdgeRef[] {
  const raw = asList((value ?? []) as never, portId);
  const numbers = raw.map((entry, index) => {
    if (typeof entry !== 'number' || Number.isNaN(entry)) {
      throw new Error(`Edge value ${index} is not a number`);
    }
    return entry;
  });
  return unpackEdgeRefs(numbers);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function isZero(v: Vec3): boolean {
  return Math.hypot(v.x, v.y, v.z) < 1e-9;
}

/**
 * How far apart two edges sit in bounding-box space. Because both sides are
 * fractions rather than millimetres, resizing the body leaves the score alone,
 * which is the whole point of storing it this way.
 */
function score(ref: EdgeRef, candidate: EdgeInfo): number {
  const dx = ref.fraction.x - candidate.fraction.x;
  const dy = ref.fraction.y - candidate.fraction.y;
  const dz = ref.fraction.z - candidate.fraction.z;
  return Math.hypot(dx, dy, dz);
}

/** Beyond this the nearest edge is a different edge, not a moved one. */
const MATCH_TOLERANCE = 0.2;
/** Below this the candidate points a different way and is not the same edge. */
const DIRECTION_AGREEMENT = 0.8;

export function resolveEdgeRefs(
  oc: OpenCascadeInstance,
  shape: Shape,
  refs: readonly EdgeRef[],
): Shape[] {
  const { mesh, edgeHandles } = tessellate(oc, shape, 1.0, 0.6);
  if (mesh.edges.length === 0) throw new Error('That shape has no edges');

  const resolved: Shape[] = [];
  for (const [index, ref] of refs.entries()) {
    let best: number | null = null;
    let bestScore = Infinity;

    for (const [candidate, info] of mesh.edges.entries()) {
      // A straight edge that has turned to point elsewhere is a different edge.
      if (
        !isZero(ref.direction) &&
        !isZero(info.direction) &&
        Math.abs(dot(ref.direction, info.direction)) < DIRECTION_AGREEMENT
      ) {
        continue;
      }

      const distance = score(ref, info);
      if (distance < bestScore) {
        bestScore = distance;
        best = candidate;
      }
    }

    if (best === null || bestScore > MATCH_TOLERANCE) {
      throw new Error(
        `Edge ${index + 1} of the selection is no longer on this shape — ` +
          'it was removed, or the model moved too far for it to be recognised',
      );
    }

    const handle = edgeHandles[best];
    if (handle === undefined) throw new Error(`Could not resolve edge ${index + 1}`);
    if (!resolved.some((seen) => seen.IsSame(handle))) resolved.push(handle);
  }

  return resolved;
}

export function createEdgeNodes(_oc: OpenCascadeInstance): NodeDefinition[] {
  const selection: NodeDefinition = {
    ...edgeSelectionSchema,
    evaluate(inputs) {
      // Validated here so a malformed selection is reported on the node holding
      // it rather than on whatever consumes it later.
      const refs = readEdgeRefs(inputs.refs ?? [], 'refs');
      return { edges: packEdgeRefs(refs) };
    },
  };

  return [selection];
}
