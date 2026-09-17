import type { PlaneValue, Vec3 } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from './kernel.js';
import { pointOnPlane } from './plane.js';

/** Gather several shapes into one, so an export can carry every visible body. */
export function compoundOf(oc: OpenCascadeInstance, shapes: readonly Shape[]): Shape {
  if (shapes.length === 1) return shapes[0]!;
  if (shapes.length === 0) throw new Error('Nothing to export');

  const compound = new oc.TopoDS_Compound();
  const builder = new oc.BRep_Builder();
  builder.MakeCompound(compound);
  for (const shape of shapes) builder.Add(compound, shape);
  builder.delete?.();
  return compound;
}

export function faceFromWire(oc: OpenCascadeInstance, wire: Shape): Shape {
  const maker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  if (!maker.IsDone()) {
    maker.delete();
    throw new Error('Profile does not bound a planar face');
  }
  const face = maker.Face();
  maker.delete();
  return face;
}

/** Closed polygon through world-space points. */
export function wireFromPoints(oc: OpenCascadeInstance, points: readonly Vec3[]): Shape {
  if (points.length < 3) throw new Error('A profile needs at least three points');

  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  for (let i = 0; i < points.length; i++) {
    const from = points[i]!;
    const to = points[(i + 1) % points.length]!;
    if (from.x === to.x && from.y === to.y && from.z === to.z) continue;

    const p1 = new oc.gp_Pnt_3(from.x, from.y, from.z);
    const p2 = new oc.gp_Pnt_3(to.x, to.y, to.z);
    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
    wireMaker.Add_1(edgeMaker.Edge());
    edgeMaker.delete();
    p1.delete();
    p2.delete();
  }

  const wire = wireMaker.Wire();
  wireMaker.delete();
  return wire;
}

export function faceFromPoints(oc: OpenCascadeInstance, points: readonly Vec3[]): Shape {
  return faceFromWire(oc, wireFromPoints(oc, points));
}

export function polygonFace(
  oc: OpenCascadeInstance,
  plane: PlaneValue,
  uv: readonly number[],
): Shape {
  const points: Vec3[] = [];
  for (let i = 0; i + 1 < uv.length; i += 2) {
    points.push(pointOnPlane(plane, uv[i]!, uv[i + 1]!));
  }
  return faceFromPoints(oc, points);
}

export function rectangleFace(
  oc: OpenCascadeInstance,
  plane: PlaneValue,
  width: number,
  height: number,
  u: number,
  v: number,
): Shape {
  return faceFromPoints(oc, [
    pointOnPlane(plane, u, v),
    pointOnPlane(plane, u + width, v),
    pointOnPlane(plane, u + width, v + height),
    pointOnPlane(plane, u, v + height),
  ]);
}

export function circleWire(
  oc: OpenCascadeInstance,
  plane: PlaneValue,
  radius: number,
  u: number,
  v: number,
): Shape {
  const centre = pointOnPlane(plane, u, v);

  const origin = new oc.gp_Pnt_3(centre.x, centre.y, centre.z);
  const normal = new oc.gp_Dir_4(plane.normal.x, plane.normal.y, plane.normal.z);
  const axis = new oc.gp_Ax2_3(origin, normal);
  const circle = new oc.gp_Circ_2(axis, radius);

  const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_8(circle);
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_2(edgeMaker.Edge());
  const wire = wireMaker.Wire();

  wireMaker.delete();
  edgeMaker.delete();
  circle.delete();
  axis.delete();
  normal.delete();
  origin.delete();

  return wire;
}

export function circleFace(
  oc: OpenCascadeInstance,
  plane: PlaneValue,
  radius: number,
  u: number,
  v: number,
): Shape {
  return faceFromWire(oc, circleWire(oc, plane, radius, u, v));
}

/**
 * A face bounded by one wire with others taken out of it.
 *
 * Orientation is the caller's to get right: the outer wire has to run
 * anticlockwise about the face normal and each hole the other way. A hole wire
 * running the same way as the outer one does not fail — it quietly builds a
 * face that is wrong.
 */
export function faceWithHoles(
  oc: OpenCascadeInstance,
  outer: Shape,
  holes: readonly Shape[],
): Shape {
  const maker = new oc.BRepBuilderAPI_MakeFace_15(outer, true);
  for (const hole of holes) maker.Add(hole);

  if (!maker.IsDone()) {
    maker.delete();
    throw new Error('Those outlines do not bound a face');
  }

  const face = maker.Face();
  maker.delete();
  return face;
}
