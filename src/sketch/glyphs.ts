import type { Constraint, Point, Sketch } from './model.js';

/**
 * The little symbols that say what a sketch's relations are: a bar for a
 * horizontal edge, a pair of slashes for parallel ones, a ring for concentric
 * circles. A dimension shows itself — it has a number on it — but a relation is
 * invisible without one of these, which leaves a sketch moving in ways nothing
 * on screen explains.
 *
 * No standard specifies them. ISO 1101 fixes ∥, ⊥ and ◎ as geometric tolerance
 * symbols and every CAD program has borrowed those; the rest — the bar, the
 * stroke, the equals sign, the dot — are a shared convention rather than a rule,
 * and what is drawn here follows it.
 *
 * Each glyph is a handful of strokes in a box one unit across, scaled to a fixed
 * size in pixels and left upright whatever the geometry does, because a symbol
 * that rotates with its edge stops being legible as a symbol.
 */

export type GlyphKind =
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equal'
  | 'coincident'
  | 'concentric'
  | 'pointOnLine'
  | 'midpoint';

export interface Glyph {
  /** Index into the sketch's constraints, so a click can find its rule. */
  constraint: number;
  kind: GlyphKind;
  /** The middle of the symbol, in the sketch plane's axes. */
  at: Point;
  lines: Array<[Point, Point]>;
}

/** The side of the box a glyph is drawn in, in pixels. */
const GLYPH = 11;
/** How far off the geometry a glyph sits, in pixels. */
const STANDOFF = 15;
/** How far apart glyphs sharing an anchor are spread, in glyph widths. */
const STACK = 1.45;

/** Strokes in a box running -0.5 to 0.5, drawn as polylines. */
const STROKES: Record<GlyphKind, Array<Array<[number, number]>>> = {
  // A bar, and a stroke: the edge lies the way the mark does.
  horizontal: [
    [
      [-0.5, 0],
      [0.5, 0],
    ],
  ],
  vertical: [
    [
      [0, -0.5],
      [0, 0.5],
    ],
  ],
  // ISO 1101's parallelism and perpendicularity symbols.
  parallel: [
    [
      [-0.35, -0.5],
      [-0.05, 0.5],
    ],
    [
      [0.15, -0.5],
      [0.45, 0.5],
    ],
  ],
  perpendicular: [
    [
      [0, 0.5],
      [0, -0.45],
    ],
    [
      [-0.45, -0.45],
      [0.45, -0.45],
    ],
  ],
  equal: [
    [
      [-0.45, 0.18],
      [0.45, 0.18],
    ],
    [
      [-0.45, -0.18],
      [0.45, -0.18],
    ],
  ],
  // A point standing for itself: small, closed, and not a circle, so it is not
  // mistaken for the concentric mark.
  coincident: [
    [
      [0, 0.32],
      [0.32, 0],
      [0, -0.32],
      [-0.32, 0],
      [0, 0.32],
    ],
  ],
  concentric: [ring(0.5), ring(0.22)],
  // A mark sitting on a line it belongs to.
  pointOnLine: [
    [
      [-0.5, -0.32],
      [0.5, -0.32],
    ],
    [
      [0, 0.42],
      [0.26, 0.16],
      [0, -0.1],
      [-0.26, 0.16],
      [0, 0.42],
    ],
  ],
  // Halfway along: a bar with its middle marked.
  midpoint: [
    [
      [-0.5, -0.3],
      [0.5, -0.3],
    ],
    [
      [-0.3, -0.3],
      [0, 0.4],
      [0.3, -0.3],
    ],
  ],
};

function ring(radius: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let step = 0; step <= 10; step++) {
    const turn = (step / 10) * Math.PI * 2;
    out.push([Math.cos(turn) * radius, Math.sin(turn) * radius]);
  }
  return out;
}

function unit(u: number, v: number): Point {
  const size = Math.hypot(u, v);
  return size < 1e-9 ? { u: 1, v: 0 } : { u: u / size, v: v / size };
}

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

/** Where one glyph wants to go, before crowding is sorted out. */
interface Placement {
  constraint: number;
  kind: GlyphKind;
  /** What it hangs off, so glyphs on the same thing can be spread apart. */
  key: string;
  at: Point;
  /** The direction to spread along when several share a key. */
  spread: Point;
}

/** What a relation hangs off: the edges it names, or the point it names. */
function placementsOf(
  constraint: Constraint,
  index: number,
  sketch: Sketch,
  points: readonly Point[],
  centre: Point,
  scale: number,
): Placement[] {
  const onLine = (line: number, kind: GlyphKind): Placement | null => {
    const entity = sketch.entities[line];
    if (entity?.kind !== 'line') return null;
    const from = points[entity.a];
    const to = points[entity.b];
    if (from === undefined || to === undefined) return null;

    const middle = { u: (from.u + to.u) / 2, v: (from.v + to.v) / 2 };
    const along = unit(to.u - from.u, to.v - from.v);
    const away = { u: -along.v, v: along.u };
    // Outside the shape, like a dimension, but closer in than one — a relation
    // belongs to its edge, and a dimension belongs to the drawing.
    const side = away.u * (middle.u - centre.u) + away.v * (middle.v - centre.v) < 0 ? -1 : 1;

    return {
      constraint: index,
      kind,
      key: `line${line}`,
      at: {
        u: middle.u + away.u * side * STANDOFF * scale,
        v: middle.v + away.v * side * STANDOFF * scale,
      },
      spread: along,
    };
  };

  const onPoint = (point: number, kind: GlyphKind): Placement | null => {
    const at = points[point];
    if (at === undefined) return null;
    // Up and to the right of the point, out of the way of whatever meets there.
    const out = STANDOFF * scale * 0.8;
    return {
      constraint: index,
      kind,
      key: `point${point}`,
      at: { u: at.u + out, v: at.v + out },
      spread: { u: 1, v: 0 },
    };
  };

  const kept = (entries: Array<Placement | null>): Placement[] =>
    entries.filter((entry): entry is Placement => entry !== null);

  switch (constraint.kind) {
    case 'horizontal':
      return kept([onLine(constraint.line, 'horizontal')]);
    case 'vertical':
      return kept([onLine(constraint.line, 'vertical')]);
    case 'parallel':
    case 'perpendicular':
    case 'equal':
      // Both edges carry the mark: a relation between two things said on only
      // one of them is half a sentence.
      return kept([onLine(constraint.a, constraint.kind), onLine(constraint.b, constraint.kind)]);
    case 'coincident':
      return kept([onPoint(constraint.a, 'coincident')]);
    case 'concentric': {
      const circle = sketch.entities[constraint.a];
      if (circle?.kind !== 'circle') return [];
      return kept([onPoint(circle.centre, 'concentric')]);
    }
    case 'pointOnLine':
      return kept([onPoint(constraint.point, 'pointOnLine')]);
    case 'midpoint':
      return kept([onPoint(constraint.point, 'midpoint')]);
    default:
      // Dimensions draw themselves, and the origin lock is not a relation
      // anybody needs to see.
      return [];
  }
}

/**
 * Every relation the sketch carries, drawn.
 *
 * Glyphs sharing an anchor are spread along it rather than stacked on top of
 * each other, so an edge that is both horizontal and equal to another says both.
 */
export function glyphsFor(
  sketch: Sketch,
  points: readonly Point[],
  /** Model units per pixel, so the symbols keep their size on screen. */
  scale: number,
): Glyph[] {
  const centre = centreOf(points);

  const placements: Placement[] = [];
  for (const [index, constraint] of sketch.constraints.entries()) {
    placements.push(...placementsOf(constraint, index, sketch, points, centre, scale));
  }

  const size = GLYPH * scale;
  const gap = STACK * size;
  const taken: Point[] = [];
  const out: Glyph[] = [];

  for (const placement of placements) {
    // Everything drawn so far is in the way, whatever it hangs off: a mark on a
    // point and a mark on the edge through it want the same piece of paper. So
    // each one steps along its own edge, to either side in turn, until it has
    // somewhere clear to sit.
    let at = placement.at;
    for (let step = 0; step < 12; step++) {
      const shift = Math.ceil(step / 2) * gap * (step % 2 === 0 ? 1 : -1);
      at = {
        u: placement.at.u + placement.spread.u * shift,
        v: placement.at.v + placement.spread.v * shift,
      };
      if (!taken.some((other) => Math.hypot(other.u - at.u, other.v - at.v) < gap * 0.9)) break;
    }
    taken.push(at);

    const lines: Array<[Point, Point]> = [];
    for (const stroke of STROKES[placement.kind]) {
      for (let i = 0; i + 1 < stroke.length; i++) {
        const [au, av] = stroke[i]!;
        const [bu, bv] = stroke[i + 1]!;
        lines.push([
          { u: at.u + au * size, v: at.v + av * size },
          { u: at.u + bu * size, v: at.v + bv * size },
        ]);
      }
    }

    out.push({ constraint: placement.constraint, kind: placement.kind, at, lines });
  }

  return out;
}

/** How close a click has to be to count as hitting a glyph, in model units. */
export function glyphReach(scale: number): number {
  return (GLYPH * scale) / 2;
}
