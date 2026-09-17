import type { Constraint, Point, Sketch } from './model.js';

/**
 * A dimension as it is drawn: the lines that carry it, and where its number
 * sits. Everything is in the sketch plane's own U/V axes, so whoever draws it
 * decides how a point in the plane becomes a point on screen.
 *
 * Sizes are given in pixels and converted with `scale`, so a dimension keeps
 * its proportions as the view zooms rather than growing with the model.
 */
export interface Annotation {
  /** Index into the sketch's constraints, so a click can find its rule. */
  constraint: number;
  dimension: string;
  value: number;
  /** What the number reads as, units and all. */
  text: string;
  /** Witness lines, the dimension line itself, and its arrowheads. */
  lines: Array<[Point, Point]>;
  /** Where the number goes. */
  label: Point;
}

/** How far the dimension line sits off what it measures, in pixels. */
const OFFSET = 30;
/** How far a witness line runs past the dimension line, in pixels. */
const OVERSHOOT = 6;
const ARROW = 9;
const ARROW_SPREAD = 0.3;
/** Radius of the arc an angle is drawn on, in pixels. */
const ARC = 34;

function add(a: Point, b: Point, times = 1): Point {
  return { u: a.u + b.u * times, v: a.v + b.v * times };
}

function subtract(a: Point, b: Point): Point {
  return { u: a.u - b.u, v: a.v - b.v };
}

function length(a: Point): number {
  return Math.hypot(a.u, a.v);
}

function unit(a: Point): Point {
  const size = length(a);
  return size < 1e-9 ? { u: 1, v: 0 } : { u: a.u / size, v: a.v / size };
}

/** Turned a quarter turn, which is the direction a dimension is offset along. */
function across(a: Point): Point {
  return { u: -a.v, v: a.u };
}

function midpoint(a: Point, b: Point): Point {
  return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
}

/** Two short lines making the head of an arrow at `at`, pointing along `along`. */
function arrowhead(at: Point, along: Point, size: number): Array<[Point, Point]> {
  const back = unit({ u: -along.u, v: -along.v });
  const side = across(back);
  return [
    [at, add(add(at, back, size), side, size * ARROW_SPREAD)],
    [at, add(add(at, back, size), side, -size * ARROW_SPREAD)],
  ];
}

export function formatLength(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '');
}

/** The middle of everything drawn, so dimensions can be put on the outside of it. */
function centreOf(points: readonly Point[]): Point {
  if (points.length === 0) return { u: 0, v: 0 };
  let u = 0;
  let v = 0;
  for (const point of points) {
    u += point.u;
    v += point.v;
  }
  return { u: u / points.length, v: v / points.length };
}

interface Measured {
  from: Point;
  to: Point;
  /** The direction the dimension is measured along. */
  along: Point;
}

/** What a distance-like constraint spans, and in which direction it reads. */
function span(constraint: Constraint, points: readonly Point[]): Measured | null {
  if (constraint.kind === 'distance') {
    const from = points[constraint.a];
    const to = points[constraint.b];
    if (from === undefined || to === undefined) return null;
    return { from, to, along: unit(subtract(to, from)) };
  }

  if (constraint.kind === 'horizontalDistance' || constraint.kind === 'verticalDistance') {
    const from = points[constraint.a];
    const to = points[constraint.b];
    if (from === undefined || to === undefined) return null;

    // Measured along one axis only, so the ends are squared up onto it.
    const horizontal = constraint.kind === 'horizontalDistance';
    return horizontal
      ? { from, to: { u: to.u, v: from.v }, along: { u: Math.sign(to.u - from.u) || 1, v: 0 } }
      : { from, to: { u: from.u, v: to.v }, along: { u: 0, v: Math.sign(to.v - from.v) || 1 } };
  }

  return null;
}

/**
 * Draws every dimension the sketch carries.
 *
 * A locked origin is left out: it pins the sketch rather than measuring it, and
 * drawing it would put a dimension on every sketch that says nothing about the
 * shape.
 */
export function annotate(
  sketch: Sketch,
  points: readonly Point[],
  radii: readonly number[],
  dimensions: ReadonlyMap<string, number>,
  /** Model units per pixel, so the drawing keeps its size on screen. */
  scale: number,
): Annotation[] {
  const centre = centreOf(points);
  const out: Annotation[] = [];

  for (const [index, constraint] of sketch.constraints.entries()) {
    if (!('dimension' in constraint)) continue;
    if (constraint.kind === 'lockU' || constraint.kind === 'lockV') continue;

    const value = dimensions.get(constraint.dimension) ?? 0;
    const base = { constraint: index, dimension: constraint.dimension, value };

    if (constraint.kind === 'radius') {
      const entity = sketch.entities[constraint.circle];
      if (entity?.kind !== 'circle') continue;
      const at = points[entity.centre];
      if (at === undefined) continue;

      const radius = radii[constraint.circle] ?? 0;
      // Out at a slant, so the leader does not lie along anything already drawn.
      const along = unit({ u: 1, v: 1 });
      const rim = add(at, along, radius);
      const tail = add(rim, along, OFFSET * scale);

      out.push({
        ...base,
        text: `R${formatLength(value)}`,
        lines: [[at, tail], ...arrowhead(rim, { u: -along.u, v: -along.v }, ARROW * scale)],
        label: add(tail, along, OVERSHOOT * scale),
      });
      continue;
    }

    if (constraint.kind === 'angle') {
      const first = sketch.entities[constraint.a];
      const second = sketch.entities[constraint.b];
      if (first?.kind !== 'line' || second?.kind !== 'line') continue;

      const corner = cornerOf(sketch, points, constraint.a, constraint.b);
      if (corner === null) continue;

      const radius = ARC * scale;
      const steps = 12;
      const lines: Array<[Point, Point]> = [];
      let previous = add(corner.at, corner.from, radius);
      for (let step = 1; step <= steps; step++) {
        const turn = corner.start + (corner.sweep * step) / steps;
        const next = add(corner.at, { u: Math.cos(turn), v: Math.sin(turn) }, radius);
        lines.push([previous, next]);
        previous = next;
      }

      const middle = corner.start + corner.sweep / 2;
      const facing = { u: Math.cos(middle), v: Math.sin(middle) };
      out.push({
        ...base,
        text: `${formatLength(value)}°`,
        lines,
        label: add(corner.at, facing, radius + OVERSHOOT * 2 * scale),
      });
      continue;
    }

    const measured = span(constraint, points);
    if (measured === null) continue;

    // Offset to whichever side faces away from the drawing, so the dimension
    // lands outside the shape rather than across it.
    const away = across(measured.along);
    const towards = subtract(midpoint(measured.from, measured.to), centre);
    const side = away.u * towards.u + away.v * towards.v < 0 ? -1 : 1;
    const out_ = { u: away.u * side, v: away.v * side };

    const from = add(measured.from, out_, OFFSET * scale);
    const to = add(measured.to, out_, OFFSET * scale);
    const head = ARROW * scale;

    out.push({
      ...base,
      text: formatLength(value),
      lines: [
        [measured.from, add(from, out_, OVERSHOOT * scale)],
        [measured.to, add(to, out_, OVERSHOOT * scale)],
        [from, to],
        ...arrowhead(from, { u: -measured.along.u, v: -measured.along.v }, head),
        ...arrowhead(to, measured.along, head),
      ],
      label: add(midpoint(from, to), out_, OVERSHOOT * scale),
    });
  }

  return out;
}

/** Where two lines meet, and the turn from one to the other. */
function cornerOf(
  sketch: Sketch,
  points: readonly Point[],
  a: number,
  b: number,
): { at: Point; from: Point; start: number; sweep: number } | null {
  const first = sketch.entities[a];
  const second = sketch.entities[b];
  if (first?.kind !== 'line' || second?.kind !== 'line') return null;

  const p1 = points[first.a];
  const p2 = points[first.b];
  const p3 = points[second.a];
  const p4 = points[second.b];
  if (p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined) return null;

  const d1 = subtract(p2, p1);
  const d2 = subtract(p4, p3);
  const denominator = d1.u * d2.v - d1.v * d2.u;
  if (Math.abs(denominator) < 1e-9) return null;

  const t = ((p3.u - p1.u) * d2.v - (p3.v - p1.v) * d2.u) / denominator;
  const at = add(p1, d1, t);

  const start = Math.atan2(d1.v, d1.u);
  let sweep = Math.atan2(d2.v, d2.u) - start;
  while (sweep <= -Math.PI) sweep += Math.PI * 2;
  while (sweep > Math.PI) sweep -= Math.PI * 2;

  return { at, from: unit(d1), start, sweep };
}
