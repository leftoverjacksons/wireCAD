import type { Vec3 } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from './kernel.js';

/**
 * What an extrusion would do to a body it is near, before it is told to do
 * anything to it.
 *
 * An extrude's operation is a guess about intent, and the geometry answers
 * most of it: a prism that runs into a body is almost always meant to cut it,
 * and one standing on a body's face, reaching away from it, is meant to join
 * it. Both are asked of the kernel rather than worked out from which face the
 * sketch is on, because a sketch on one body can reach another, and a body
 * that is not convex can be run into by an extrusion pointing away from it.
 */
export interface Contact {
  /** Volume the bare prism shares with the body, in cubic millimetres. */
  overlap: number;
  /** Whether either end of the prism lies against the body without entering it. */
  touches: boolean;
}

/**
 * How thick a slab counts as lying against a face, in millimetres. Thin enough
 * that a body a visible gap away is not touched, thick enough to be well above
 * the kernel's own tolerance.
 */
const CONTACT = 1e-3;
/** Below this fraction of the prism's volume, a shared volume is a rounding. */
const OVERLAP_FRACTION = 1e-6;
/** Below this fraction of a slab's volume, the slab only grazes the body. */
const TOUCH_FRACTION = 1e-3;

function volumeOf(oc: OpenCascadeInstance, shape: Shape): number {
  const props = new oc.GProp_GProps_1();
  oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
  const mass = props.Mass();
  props.delete?.();
  // A reversed solid reports a negative volume, which says nothing about size.
  return Math.abs(mass);
}

function prism(oc: OpenCascadeInstance, profile: Shape, along: Vec3, length: number): Shape {
  const vector = new oc.gp_Vec_4(along.x * length, along.y * length, along.z * length);
  const maker = new oc.BRepPrimAPI_MakePrism_1(profile, vector, false, true);
  const shape = maker.Shape();
  maker.delete?.();
  vector.delete?.();
  return shape;
}

function translated(oc: OpenCascadeInstance, shape: Shape, by: Vec3): Shape {
  const trsf = new oc.gp_Trsf_1();
  const vector = new oc.gp_Vec_4(by.x, by.y, by.z);
  trsf.SetTranslation_1(vector);
  const maker = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
  const moved = maker.Shape();
  maker.delete?.();
  vector.delete?.();
  trsf.delete?.();
  return moved;
}

/**
 * The volume two shapes share, or null when the kernel would not say.
 *
 * Null rather than zero: with exceptions turned off, a boolean that failed
 * returns something wrong instead of throwing, and a failure read as "no
 * overlap" would quietly default the extrude to a new body.
 */
function sharedVolume(oc: OpenCascadeInstance, a: Shape, b: Shape): number | null {
  const common = new oc.BRepAlgoAPI_Common_3(a, b);
  try {
    common.Build();
    if (!common.IsDone()) return null;
    const result = common.Shape();
    const volume = volumeOf(oc, result);
    result.delete?.();
    return Number.isFinite(volume) ? volume : null;
  } catch {
    return null;
  } finally {
    common.delete?.();
  }
}

/** One extrusion, measured against as many bodies as there are. */
export interface ExtrudeProbe {
  /** Null when the kernel could not answer for this body. */
  against(body: Shape): Contact | null;
  dispose(): void;
}

export function probeExtrude(
  oc: OpenCascadeInstance,
  profile: Shape,
  normal: Vec3,
  distance: number,
): ExtrudeProbe | null {
  if (distance === 0) return null;

  // Everything is built along the way the extrusion actually runs, so "behind"
  // is the side the profile sits on and "beyond" is past its far end.
  const sign = Math.sign(distance);
  const forward = { x: normal.x * sign, y: normal.y * sign, z: normal.z * sign };
  const backward = { x: -forward.x, y: -forward.y, z: -forward.z };
  const length = Math.abs(distance);

  const body = prism(oc, profile, forward, length);
  const volume = volumeOf(oc, body);
  // A profile with no area — nothing closed in it — makes nothing to measure.
  if (!(volume > 0)) {
    body.delete?.();
    return null;
  }

  const behind = prism(oc, profile, backward, CONTACT);
  const end = translated(oc, profile, {
    x: forward.x * length,
    y: forward.y * length,
    z: forward.z * length,
  });
  const beyond = prism(oc, end, forward, CONTACT);
  end.delete?.();
  const slab = volume / length * CONTACT;

  return {
    against(target) {
      const overlap = sharedVolume(oc, body, target);
      if (overlap === null) return null;
      if (overlap > volume * OVERLAP_FRACTION) return { overlap, touches: false };

      const back = sharedVolume(oc, behind, target);
      const front = sharedVolume(oc, beyond, target);
      if (back === null && front === null) return null;
      const touches =
        (back ?? 0) > slab * TOUCH_FRACTION || (front ?? 0) > slab * TOUCH_FRACTION;
      return { overlap: 0, touches };
    },
    dispose() {
      body.delete?.();
      behind.delete?.();
      beyond.delete?.();
    },
  };
}
