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
  /** Index into the sketch's constraints, so a click can find its rule. -1 while placing. */
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

/**
 * Where a dimension was put, relative to what it measures, in millimetres.
 *
 * Relative rather than absolute, so a dimension stays where it was put as the
 * geometry it measures moves: `offset` is how far off the measured span the
 * dimension line sits, and `slide` is how far the number has been slid along
 * it. A radius reads them as a leader length and a leader angle; an angle reads
 * `offset` as how far out its arc is drawn.
 */
export interface Place {
  offset: number;
  slide: number;
}

/** The three things a straight measurement between two points can mean. */
export type SpanKind = 'distance' | 'horizontalDistance' | 'verticalDistance';

/** How far a dimension line sits off what it measures by default, in pixels. */
const OFFSET = 26;
/** How far a witness line runs past the dimension line, in pixels. */
const OVERSHOOT = 4;
/**
 * Arrowheads, in pixels. ISO 129-1 and ASME Y14.5 both want one about three
 * times as long as it is wide; ours is drawn open rather than filled, which is
 * the usual concession on screen.
 */
const ARROW = 7;
const ARROW_SPREAD = 1 / 6;
/** Radius of the arc an angle is drawn on, in pixels. */
const ARC = 34;
/** Within this, in millimetres, a span is straight enough to have no components. */
const STRAIGHT = 1e-6;
/** A construction line's dash and the gap after it, in pixels. */
const DASH = 7;
const DASH_GAP = 5;
/**
 * The most dashes one line is drawn with. A line asking for more is zoomed so
 * far out that its dashes are a pixel apart anyway, and drawing thousands of
 * them costs more than looking at them is worth. Past this the pattern stretches
 * rather than the count growing.
 */
const MAX_DASHES = 120;
/**
 * How much a placement has to favour an axis before it stops meaning the
 * measurement it is nearest. Dragging straight out from a line is the common
 * gesture and should keep giving the length of the line.
 */
const ALIGNED_BIAS = 0.12;

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

function dot(a: Point, b: Point): number {
  return a.u * b.u + a.v * b.v;
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

/**
 * A line as the dashes it is drawn with, which is how construction geometry is
 * told apart from the outline.
 *
 * The dash is given in pixels and turned into millimetres here, like every
 * other size on the drawing, so leaning in shows more dashes rather than bigger
 * ones. A line shorter than a single dash keeps a whole one: drawn as nothing
 * at all it would be worse than drawn solid.
 */
export function dashesAlong(a: Point, b: Point, scale: number): Array<readonly [Point, Point]> {
  const span = length(subtract(b, a));
  if (span < STRAIGHT) return [];

  const dash = DASH * scale;
  const gap = DASH_GAP * scale;
  if (!(dash > 0) || !(gap > 0)) return [[a, b]];

  // A dash at each end, as a dashed line is drawn: the count is whatever comes
  // nearest the pattern asked for, and the pattern is then stretched or
  // squeezed to fit the line exactly rather than running off the end of it.
  const duty = dash / (dash + gap);
  const count = Math.min(MAX_DASHES, Math.max(1, Math.round((span + gap) / (dash + gap))));
  const period = span / (count - 1 + duty);
  const on = period * duty;

  const along = unit(subtract(b, a));
  const out: Array<readonly [Point, Point]> = [];
  for (let index = 0; index < count; index++) {
    out.push([add(a, along, index * period), add(a, along, index * period + on)]);
  }
  return out;
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

/** What a span of the given kind measures, and in which direction it reads. */
export function spanOf(kind: SpanKind, from: Point, to: Point): Measured {
  if (kind === 'distance') return { from, to, along: unit(subtract(to, from)) };

  // Measured along one axis only, so the ends are squared up onto it.
  return kind === 'horizontalDistance'
    ? { from, to: { u: to.u, v: from.v }, along: { u: Math.sign(to.u - from.u) || 1, v: 0 } }
    : { from, to: { u: from.u, v: to.v }, along: { u: 0, v: Math.sign(to.v - from.v) || 1 } };
}

/** What a distance-like constraint spans, and in which direction it reads. */
function span(constraint: Constraint, points: readonly Point[]): Measured | null {
  if (
    constraint.kind !== 'distance' &&
    constraint.kind !== 'horizontalDistance' &&
    constraint.kind !== 'verticalDistance'
  ) {
    return null;
  }

  const from = points[constraint.a];
  const to = points[constraint.b];
  if (from === undefined || to === undefined) return null;
  return spanOf(constraint.kind, from, to);
}

/** What a span of this kind reads, in millimetres. */
export function measureOf(kind: SpanKind, from: Point, to: Point): number {
  if (kind === 'horizontalDistance') return Math.abs(to.u - from.u);
  if (kind === 'verticalDistance') return Math.abs(to.v - from.v);
  return Math.hypot(to.u - from.u, to.v - from.v);
}

/** Where a dimension of this kind ends up, given where the cursor put it. */
export function placeOfSpan(kind: SpanKind, from: Point, to: Point, cursor: Point): Place {
  const measured = spanOf(kind, from, to);
  const offset = subtract(cursor, midpoint(measured.from, measured.to));
  return {
    offset: dot(offset, across(measured.along)),
    slide: dot(offset, measured.along),
  };
}

/**
 * Which measurement a placement means.
 *
 * Two points are three dimensions at once — the distance between them, and each
 * of its two components — and which one is wanted is said by where the dimension
 * is put: out to the side of a diagonal gives its length, straight up gives its
 * width, sideways gives its height. That is how it is done in Fusion and in
 * SolidWorks, and it is the reason placement is a step rather than a setting.
 *
 * A span already square to an axis has no components worth the name, so it is
 * always just its length.
 */
export function chooseSpan(from: Point, to: Point, cursor: Point): { kind: SpanKind; place: Place } {
  const du = to.u - from.u;
  const dv = to.v - from.v;
  const straight = Math.abs(du) < STRAIGHT || Math.abs(dv) < STRAIGHT;

  const facing = unit(subtract(cursor, midpoint(from, to)));
  const candidates: Array<{ kind: SpanKind; away: Point; bias: number }> = straight
    ? [{ kind: 'distance', away: across(unit({ u: du, v: dv })), bias: 1 }]
    : [
        { kind: 'distance', away: across(unit({ u: du, v: dv })), bias: ALIGNED_BIAS },
        { kind: 'horizontalDistance', away: { u: 0, v: 1 }, bias: 0 },
        { kind: 'verticalDistance', away: { u: 1, v: 0 }, bias: 0 },
      ];

  let best = candidates[0]!;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    // Either way along the offset direction counts: a dimension put below a
    // line means the same as one put above it.
    const score = Math.abs(dot(facing, candidate.away)) + candidate.bias;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { kind: best.kind, place: placeOfSpan(best.kind, from, to, cursor) };
}

/** Where a cursor puts an existing dimension, whatever kind it is. */
export function placeOf(
  sketch: Sketch,
  constraint: Constraint,
  points: readonly Point[],
  cursor: Point,
): Place | null {
  if (constraint.kind === 'radius') {
    const entity = sketch.entities[constraint.circle];
    if (entity?.kind !== 'circle') return null;
    const centre = points[entity.centre];
    if (centre === undefined) return null;
    const out = subtract(cursor, centre);
    return { offset: length(out), slide: Math.atan2(out.v, out.u) };
  }

  if (constraint.kind === 'angle') {
    const corner = cornerOf(sketch, points, constraint.a, constraint.b);
    if (corner === null) return null;
    return { offset: length(subtract(cursor, corner.at)), slide: 0 };
  }

  const measured = span(constraint, points);
  if (measured === null) return null;
  const offset = subtract(cursor, midpoint(measured.from, measured.to));
  return { offset: dot(offset, across(measured.along)), slide: dot(offset, measured.along) };
}

/**
 * Draws one dimension. Used both for the ones the sketch holds and for the one
 * being placed, so what you drag around is exactly what you end up with.
 */
export function annotateOne(
  sketch: Sketch,
  constraint: Constraint,
  index: number,
  points: readonly Point[],
  radii: readonly number[],
  value: number,
  /** Model units per pixel, so the drawing keeps its size on screen. */
  scale: number,
  place: Place | undefined,
  /** Which way to put an unplaced dimension: away from here. */
  centre: Point,
): Annotation | null {
  if (!('dimension' in constraint)) return null;
  if (constraint.kind === 'lockU' || constraint.kind === 'lockV') return null;

  const base = { constraint: index, dimension: constraint.dimension, value };

  if (constraint.kind === 'radius') {
    const entity = sketch.entities[constraint.circle];
    if (entity?.kind !== 'circle') return null;
    const at = points[entity.centre];
    if (at === undefined) return null;

    const radius = radii[constraint.circle] ?? 0;
    // Out at a slant by default, so the leader does not lie along anything
    // already drawn.
    const angle = place === undefined ? Math.PI / 4 : place.slide;
    const along = { u: Math.cos(angle), v: Math.sin(angle) };
    const reach =
      place === undefined
        ? radius + OFFSET * scale
        : Math.max(place.offset, radius + OVERSHOOT * scale);
    const rim = add(at, along, radius);

    return {
      ...base,
      text: `R${formatLength(value)}`,
      lines: [
        [at, add(at, along, reach)],
        ...arrowhead(rim, { u: -along.u, v: -along.v }, ARROW * scale),
      ],
      label: add(at, along, reach),
    };
  }

  if (constraint.kind === 'angle') {
    const corner = cornerOf(sketch, points, constraint.a, constraint.b);
    if (corner === null) return null;

    const gap = OVERSHOOT * 2 * scale;
    const reach = place === undefined ? ARC * scale + gap : Math.max(place.offset, gap * 2);
    const radius = Math.max(reach - gap, gap);
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
    return {
      ...base,
      text: `${formatLength(value)}°`,
      lines,
      label: add(corner.at, facing, reach),
    };
  }

  const measured = span(constraint, points);
  if (measured === null) return null;

  // Unplaced, it goes to whichever side faces away from the drawing, so it
  // lands outside the shape rather than across it. Placed, it goes where it
  // was put.
  const away = across(measured.along);
  const towards = subtract(midpoint(measured.from, measured.to), centre);
  const side = dot(away, towards) < 0 ? -1 : 1;
  const offset = place === undefined ? OFFSET * scale * side : place.offset;
  const slide = place === undefined ? 0 : place.slide;

  const from = add(measured.from, away, offset);
  const to = add(measured.to, away, offset);
  const tip = OVERSHOOT * scale * (offset < 0 ? -1 : 1);
  const head = ARROW * scale;

  return {
    ...base,
    text: formatLength(value),
    lines: [
      [measured.from, add(from, away, tip)],
      [measured.to, add(to, away, tip)],
      [from, to],
      ...arrowhead(from, { u: -measured.along.u, v: -measured.along.v }, head),
      ...arrowhead(to, measured.along, head),
    ],
    label: add(midpoint(from, to), measured.along, slide),
  };
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
  scale: number,
  places: ReadonlyMap<string, Place> = new Map(),
): Annotation[] {
  const centre = centreOf(points);
  const out: Annotation[] = [];

  for (const [index, constraint] of sketch.constraints.entries()) {
    if (!('dimension' in constraint)) continue;
    const drawn = annotateOne(
      sketch,
      constraint,
      index,
      points,
      radii,
      dimensions.get(constraint.dimension) ?? 0,
      scale,
      places.get(constraint.dimension),
      centre,
    );
    if (drawn !== null) out.push(drawn);
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

// ---------------------------------------------------------------- storage
//
// Where a dimension was put travels with the sketch as a flat list of name,
// offset and slide. It says nothing about the shape, so it is stored apart from
// the constraints and nothing is rebuilt when it changes.

export function encodePlaces(places: ReadonlyMap<string, Place>): Array<string | number> {
  const out: Array<string | number> = [];
  for (const [name, place] of places) out.push(name, place.offset, place.slide);
  return out;
}

export function decodePlaces(value: unknown): Map<string, Place> {
  const out = new Map<string, Place>();
  if (!Array.isArray(value)) return out;
  for (let i = 0; i + 2 < value.length; i += 3) {
    const name = value[i];
    const offset = value[i + 1];
    const slide = value[i + 2];
    if (typeof name !== 'string') continue;
    if (typeof offset !== 'number' || typeof slide !== 'number') continue;
    if (!Number.isFinite(offset) || !Number.isFinite(slide)) continue;
    out.set(name, { offset, slide });
  }
  return out;
}
