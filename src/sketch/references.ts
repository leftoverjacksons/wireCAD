import type { PlaneValue, Vec3 } from '../core/types.js';
import type { EdgeInfo } from '../geometry/kernel.js';
import { planeYAxis } from '../geometry/plane.js';
import { edgeRefOf, matchEdgeRefs } from '../nodes/edges.js';
import type { Point, Sketch } from './model.js';
import { fixedPoints, refsOf } from './model.js';

/**
 * The body's edges, as a sketch sees them.
 *
 * A sketch on a face has nothing to measure from but the face, and the face is
 * not in the sketch. So an edge of the body can be laid into it: projected onto
 * the sketch plane, its ends become points the solver is not allowed to move,
 * and from then on they are picked, dimensioned and constrained against like
 * anything drawn. Nothing asks for the projection to be made — clicking the
 * edge is the asking.
 *
 * All of this works on the tessellation's description of the edges rather than
 * on the kernel's own, so the view can place a reference from the mesh it is
 * already drawing and the worker can place the same one from the shape, and the
 * two cannot disagree about where it is.
 */

/** Below this, in millimetres, a projected edge has no length to speak of. */
const DEGENERATE = 1e-6;

/** Where a model point lands in the plane's own axes, dropped along its normal. */
export function toPlane(plane: PlaneValue, point: Vec3): Point {
  const y = planeYAxis(plane);
  const dx = point.x - plane.origin.x;
  const dy = point.y - plane.origin.y;
  const dz = point.z - plane.origin.z;
  return {
    u: dx * plane.xAxis.x + dy * plane.xAxis.y + dz * plane.xAxis.z,
    v: dx * y.x + dy * y.y + dz * y.z,
  };
}

/** How far off the plane a model point sits, which is what breaks a tie. */
function offPlane(plane: PlaneValue, point: Vec3): number {
  return Math.abs(
    (point.x - plane.origin.x) * plane.normal.x +
      (point.y - plane.origin.y) * plane.normal.y +
      (point.z - plane.origin.z) * plane.normal.z,
  );
}

/** A straight edge is as long as the gap between its ends. */
export function isStraight(edge: EdgeInfo): boolean {
  const chord = Math.hypot(
    edge.end.x - edge.start.x,
    edge.end.y - edge.start.y,
    edge.end.z - edge.start.z,
  );
  return !edge.closed && Math.abs(chord - edge.length) <= 1e-6 * Math.max(1, edge.length);
}

/**
 * Puts every referenced point where its edge now is.
 *
 * Returns the references nothing on the body answers to any more, by index.
 * Their points are left where they were: the caller decides whether that is an
 * error, which for a solve it is and for a drawing in progress it is not.
 */
export function placeReferences(
  sketch: Sketch,
  edges: readonly EdgeInfo[],
  plane: PlaneValue,
): number[] {
  const refs = refsOf(sketch);
  if (refs.length === 0) return [];

  const missing: number[] = [];
  const matched = matchEdgeRefs(
    edges,
    refs.map((ref) => ref.edge),
  );

  for (const [index, ref] of refs.entries()) {
    const edge = edges[matched[index]!];
    // A span and a rim are different things to be pinned to, so an edge that
    // has become the other kind is not the edge that was referred to.
    if (edge === undefined || edge.closed !== (ref.kind === 'centre')) {
      missing.push(index);
      continue;
    }

    if (ref.kind === 'centre') {
      sketch.points[ref.point] = toPlane(plane, edge.centre);
    } else {
      sketch.points[ref.a] = toPlane(plane, edge.start);
      sketch.points[ref.b] = toPlane(plane, edge.end);
    }
  }

  return missing;
}

/** Which part of an edge a click meant. */
export type ReferencePart = 'start' | 'end' | 'centre' | 'line';

export interface ReferenceHit {
  edge: number;
  part: ReferencePart;
}

function distanceToSegment(at: Point, a: Point, b: Point): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lengthSquared = du * du + dv * dv;
  if (lengthSquared < 1e-12) return Math.hypot(at.u - a.u, at.v - a.v);
  const t = Math.max(0, Math.min(1, ((at.u - a.u) * du + (at.v - a.v) * dv) / lengthSquared));
  return Math.hypot(at.u - (a.u + t * du), at.v - (a.v + t * dv));
}

/**
 * The edge of the body under a point in the sketch plane, and which part of it.
 *
 * Ends and centres win over spans, as points win over lines everywhere else in
 * a sketch: a point is the harder thing to hit. Clicking the rim of a bore
 * means its centre, because the centre is what a hole is dimensioned to and it
 * is not somewhere a click can land.
 *
 * Several edges often project onto the same place — the top and bottom of a
 * block seen from above — and then the one nearest the sketch plane is meant.
 */
export function referenceAt(
  edges: readonly EdgeInfo[],
  plane: PlaneValue,
  at: Point,
  slack: number,
  skip: ReadonlySet<number> = new Set(),
): ReferenceHit | null {
  let best: ReferenceHit | null = null;
  let bestDistance = slack;
  let bestOff = Infinity;

  const offer = (hit: ReferenceHit, distance: number, off: number): void => {
    if (distance > slack) return;
    const closer = distance < bestDistance - DEGENERATE;
    const tied = Math.abs(distance - bestDistance) <= DEGENERATE && off < bestOff;
    if (best !== null && !closer && !tied) return;
    best = hit;
    bestDistance = distance;
    bestOff = off;
  };

  for (const [index, edge] of edges.entries()) {
    if (skip.has(index)) continue;
    if (edge.closed) {
      const centre = toPlane(plane, edge.centre);
      offer(
        { edge: index, part: 'centre' },
        Math.hypot(at.u - centre.u, at.v - centre.v),
        offPlane(plane, edge.centre),
      );
      continue;
    }

    const a = toPlane(plane, edge.start);
    const b = toPlane(plane, edge.end);
    // An edge standing square to the plane projects onto a single point, which
    // the edges it meets already offer as their own ends.
    if (Math.hypot(b.u - a.u, b.v - a.v) < DEGENERATE) continue;
    offer({ edge: index, part: 'start' }, Math.hypot(at.u - a.u, at.v - a.v), offPlane(plane, edge.start));
    offer({ edge: index, part: 'end' }, Math.hypot(at.u - b.u, at.v - b.v), offPlane(plane, edge.end));
  }
  if (best !== null) return best;

  bestDistance = slack;
  bestOff = Infinity;
  for (const [index, edge] of edges.entries()) {
    if (skip.has(index)) continue;

    if (edge.closed) {
      const centre = toPlane(plane, edge.centre);
      const rim = toPlane(plane, edge.start);
      const radius = Math.hypot(rim.u - centre.u, rim.v - centre.v);
      offer(
        { edge: index, part: 'centre' },
        Math.abs(Math.hypot(at.u - centre.u, at.v - centre.v) - radius),
        offPlane(plane, edge.start),
      );
      continue;
    }

    if (!isStraight(edge)) continue;
    const a = toPlane(plane, edge.start);
    const b = toPlane(plane, edge.end);
    if (Math.hypot(b.u - a.u, b.v - a.v) < DEGENERATE) continue;
    offer({ edge: index, part: 'line' }, distanceToSegment(at, a, b), offPlane(plane, edge.midpoint));
  }

  return best;
}

/** What laying an edge into a sketch added to it. */
export interface Laid {
  /** The points now standing for the edge: its two ends, or its centre. */
  points: number[];
  /** The reference line between the ends, or -1 where the edge has none. */
  line: number;
}

/**
 * Lays an edge of the body into the sketch as something to measure from.
 *
 * A point the body already put in the same place is reused, so two edges that
 * meet at a corner share that corner in the sketch as they do on the body.
 * Only another reference point is reused that way: one that was drawn there is
 * free to move, and binding it to the body is a rule nobody asked for.
 */
export function addReference(sketch: Sketch, edge: EdgeInfo, plane: PlaneValue): Laid {
  const fixed = fixedPoints(sketch);
  const pointAt = (at: Point): number => {
    for (const index of fixed) {
      const existing = sketch.points[index]!;
      if (Math.hypot(existing.u - at.u, existing.v - at.v) < DEGENERATE) return index;
    }
    sketch.points.push(at);
    return sketch.points.length - 1;
  };

  sketch.refs ??= [];

  if (edge.closed) {
    const point = pointAt(toPlane(plane, edge.centre));
    sketch.refs.push({ kind: 'centre', point, edge: edgeRefOf(edge) });
    return { points: [point], line: -1 };
  }

  const a = pointAt(toPlane(plane, edge.start));
  const b = pointAt(toPlane(plane, edge.end));
  sketch.refs.push({ kind: 'ends', a, b, edge: edgeRefOf(edge) });

  // A curved edge has ends worth measuring to, but a straight line drawn
  // between them would be a line that is not on the body.
  if (!isStraight(edge) || a === b) return { points: [a, b], line: -1 };
  sketch.entities.push({ kind: 'line', a, b, reference: true });
  return { points: [a, b], line: sketch.entities.length - 1 };
}

/** The outline an edge would have in the sketch, for showing what a click would take. */
export function outlineOf(edge: EdgeInfo, plane: PlaneValue): Point[] {
  if (!edge.closed) return [toPlane(plane, edge.start), toPlane(plane, edge.end)];

  const centre = toPlane(plane, edge.centre);
  const rim = toPlane(plane, edge.start);
  const radius = Math.hypot(rim.u - centre.u, rim.v - centre.v);
  const out: Point[] = [];
  for (let step = 0; step <= 48; step++) {
    const angle = (step / 48) * Math.PI * 2;
    out.push({ u: centre.u + radius * Math.cos(angle), v: centre.v + radius * Math.sin(angle) });
  }
  return out;
}
