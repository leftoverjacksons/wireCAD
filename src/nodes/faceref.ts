import type { FaceInfo } from '../geometry/kernel.js';

/**
 * Naming a face that has no normal to be named by.
 *
 * `face.plane` refers to a face by its direction and its rank among the faces
 * pointing that way, which works because a plane is flat by definition. The
 * face a bore cuts is not, and neither is a rounding, so the same reference
 * cannot name the two faces most worth pointing at.
 *
 * So a face is named the way an edge is: by where its centroid sits as a
 * fraction of the body's bounding box, which does not move when the body is
 * resized, together with its area — because two faces can share a place, and
 * the area is what tells the small one from the large one.
 */

export interface FaceRef {
  /** Centroid as a fraction of the body's bounding box. */
  fx: number;
  fy: number;
  fz: number;
  /** Area in square millimetres, as the tessellation measures it. */
  area: number;
}

/** Nearer than this in the fractional box, or it is not the same face. */
const MATCH_TOLERANCE = 0.2;
/**
 * How far the area may have moved and still be the same face.
 *
 * Generous, because the face being named is usually the one being changed: a
 * bore whose radius doubles is still that bore. It is here to separate faces
 * that share a place, not to insist a face keeps its size.
 */
const AREA_RATIO = 6;

/**
 * Which face a reference points at, by index into `faces`, or -1 when nothing
 * on this body answers to it.
 *
 * Kept apart from the kernel so the same matching runs on a tessellated body
 * wherever one is to hand, and so it can be tested without one.
 */
export function matchFaceRef(faces: readonly FaceInfo[], ref: FaceRef): number {
  let best = -1;
  let bestDistance = Infinity;

  for (const [index, face] of faces.entries()) {
    if (ref.area > 0 && face.area > 0) {
      const ratio = Math.max(face.area, ref.area) / Math.min(face.area, ref.area);
      if (ratio > AREA_RATIO) continue;
    }

    const distance = Math.hypot(
      face.fraction.x - ref.fx,
      face.fraction.y - ref.fy,
      face.fraction.z - ref.fz,
    );
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = index;
  }

  return bestDistance > MATCH_TOLERANCE ? -1 : best;
}
