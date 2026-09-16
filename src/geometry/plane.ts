import type { PlaneValue, Vec3 } from '../core/types.js';

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function normalize(v: Vec3): Vec3 {
  const magnitude = length(v);
  if (magnitude === 0) throw new Error('Cannot normalize a zero-length vector');
  return scale(v, 1 / magnitude);
}

/** Any vector not parallel to `v`, for deriving a fallback in-plane axis. */
function anyPerpendicular(v: Vec3): Vec3 {
  return Math.abs(v.x) < 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0);
}

/** Normalises the normal and forces the x-axis into the plane. */
export function makePlane(origin: Vec3, normal: Vec3, xAxis?: Vec3): PlaneValue {
  const unitNormal = normalize(normal);
  const candidate = xAxis ?? anyPerpendicular(unitNormal);

  const projected = {
    x: candidate.x - unitNormal.x * dot(candidate, unitNormal),
    y: candidate.y - unitNormal.y * dot(candidate, unitNormal),
    z: candidate.z - unitNormal.z * dot(candidate, unitNormal),
  };

  const fallback = anyPerpendicular(unitNormal);
  const inPlane = length(projected) < 1e-9 ? cross(unitNormal, fallback) : projected;

  return { kind: 'plane', origin, normal: unitNormal, xAxis: normalize(inPlane) };
}

export function planeYAxis(plane: PlaneValue): Vec3 {
  return cross(plane.normal, plane.xAxis);
}

/** World position of a point given in the plane's own 2D coordinates. */
export function pointOnPlane(plane: PlaneValue, u: number, v: number): Vec3 {
  const yAxis = planeYAxis(plane);
  return add(plane.origin, add(scale(plane.xAxis, u), scale(yAxis, v)));
}

export function offsetPlane(plane: PlaneValue, distance: number): PlaneValue {
  return {
    kind: 'plane',
    origin: add(plane.origin, scale(plane.normal, distance)),
    normal: plane.normal,
    xAxis: plane.xAxis,
  };
}

export const WORLD_XY = makePlane(vec3(0, 0, 0), vec3(0, 0, 1), vec3(1, 0, 0));
export const WORLD_XZ = makePlane(vec3(0, 0, 0), vec3(0, -1, 0), vec3(1, 0, 0));
export const WORLD_YZ = makePlane(vec3(0, 0, 0), vec3(1, 0, 0), vec3(0, 1, 0));
