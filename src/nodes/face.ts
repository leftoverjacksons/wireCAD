import type { NodeDefinition, NodeSchema, Vec3 } from '../core/types.js';
import type { FaceInfo, OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { shapeOf, tessellate } from '../geometry/kernel.js';
import { length, makePlane } from '../geometry/plane.js';
import { asNumber } from './coerce.js';

export const facePlaneSchema: NodeSchema = {
  type: 'face.plane',
  label: 'Face Plane',
  category: 'Construct',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'nx', label: 'Normal X', type: 'number', default: 0 },
    { id: 'ny', label: 'Normal Y', type: 'number', default: 0 },
    { id: 'nz', label: 'Normal Z', type: 'number', default: 1 },
    { id: 'rank', label: 'Rank', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'plane', label: 'Plane', type: 'plane' }],
};

export const faceSchemas: readonly NodeSchema[] = [facePlaneSchema];

/** Cosine tolerance for treating a face normal as "the same direction". */
const ALIGNMENT = 0.995;

export interface FaceMatch {
  face: FaceInfo;
  offset: number;
}

/**
 * Faces whose normal points the requested way, ordered from furthest along that
 * normal to nearest. Ordering by projection rather than by kernel face order is
 * what keeps a reference on the top of a box pointing at the top of the box
 * after the box is resized.
 */
export function matchingFaces(faces: readonly FaceInfo[], normal: Vec3): FaceMatch[] {
  const matches: FaceMatch[] = [];

  for (const face of faces) {
    if (!face.planar || face.area <= 0) continue;
    const alignment =
      face.normal.x * normal.x + face.normal.y * normal.y + face.normal.z * normal.z;
    if (alignment < ALIGNMENT) continue;
    matches.push({
      face,
      offset: face.origin.x * normal.x + face.origin.y * normal.y + face.origin.z * normal.z,
    });
  }

  matches.sort((a, b) => b.offset - a.offset);
  return matches;
}

export function createFaceNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  const facePlane: NodeDefinition = {
    ...facePlaneSchema,
    evaluate(inputs) {
      const shape = shapeOf(inputs.solid ?? null, 'solid');
      const requested: Vec3 = {
        x: asNumber(inputs.nx ?? null, 'nx'),
        y: asNumber(inputs.ny ?? null, 'ny'),
        z: asNumber(inputs.nz ?? null, 'nz'),
      };
      if (length(requested) === 0) throw new Error('Face normal must not be zero');

      const rank = asNumber(inputs.rank ?? null, 'rank');
      if (!Number.isInteger(rank) || rank < 0) {
        throw new Error(`Rank must be a non-negative integer, got ${rank}`);
      }

      const magnitude = length(requested);
      const normal: Vec3 = {
        x: requested.x / magnitude,
        y: requested.y / magnitude,
        z: requested.z / magnitude,
      };

      // A coarse mesh is enough: planar face normals do not depend on deflection.
      const { mesh } = tessellate(oc, shape as Shape, 1.0, 0.6);
      const matches = matchingFaces(mesh.faces, normal);

      if (matches.length === 0) {
        throw new Error(
          `No planar face faces (${normal.x.toFixed(2)}, ${normal.y.toFixed(2)}, ${normal.z.toFixed(2)})`,
        );
      }
      const chosen = matches[rank];
      if (chosen === undefined) {
        throw new Error(
          `Rank ${rank} is out of range: only ${matches.length} face(s) face that way`,
        );
      }

      return { plane: makePlane(chosen.face.origin, chosen.face.normal) };
    },
  };

  return [facePlane];
}
