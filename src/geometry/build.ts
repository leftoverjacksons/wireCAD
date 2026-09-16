import type { PlaneValue, Vec3 } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from './kernel.js';
import { pointOnPlane } from './plane.js';

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
export function faceFromPoints(oc: OpenCascadeInstance, points: readonly Vec3[]): Shape {
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
  return faceFromWire(oc, wire);
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

export function circleFace(
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

  return faceFromWire(oc, wire);
}
