/**
 * A constrained sketch: points, the entities joining them, and the rules those
 * have to satisfy. Everything here is plain data so it hashes, serialises and
 * travels to the worker like any other node input.
 *
 * Positions are in the sketch plane's own U/V axes, in millimetres.
 */

import type { EdgeRef } from '../nodes/edges.js';

export interface Point {
  u: number;
  v: number;
}

/** A straight edge between two points, by index into the point list. */
export interface Line {
  kind: 'line';
  a: number;
  b: number;
  /**
   * Drawn by the model rather than by the person: an edge of the body, laid
   * into the sketch so things can be measured from it. It bounds nothing — a
   * profile is made of what was drawn, not of what it was drawn against.
   */
  reference?: true;
}

/** A circle about a point, whose radius is solved for like any other unknown. */
export interface Circle {
  kind: 'circle';
  centre: number;
  radius: number;
}

export type Entity = Line | Circle;

/**
 * A rule the sketch has to satisfy. Those carrying a `dimension` are driven:
 * the name becomes a port on the node, so the number can be typed in or wired
 * from somewhere else. The rest are relations between entities and hold no
 * number of their own.
 */
export type Constraint =
  | { kind: 'coincident'; a: number; b: number }
  | { kind: 'horizontal'; line: number }
  | { kind: 'vertical'; line: number }
  | { kind: 'parallel'; a: number; b: number }
  | { kind: 'perpendicular'; a: number; b: number }
  | { kind: 'equal'; a: number; b: number }
  | { kind: 'pointOnLine'; point: number; line: number }
  | { kind: 'concentric'; a: number; b: number }
  | { kind: 'midpoint'; point: number; line: number }
  | { kind: 'lockU'; point: number; dimension: string }
  | { kind: 'lockV'; point: number; dimension: string }
  | { kind: 'distance'; a: number; b: number; dimension: string }
  | { kind: 'horizontalDistance'; a: number; b: number; dimension: string }
  | { kind: 'verticalDistance'; a: number; b: number; dimension: string }
  /** How far a point stands off a line, measured square to it. */
  | { kind: 'lineDistance'; point: number; line: number; dimension: string }
  | { kind: 'radius'; circle: number; dimension: string }
  | { kind: 'angle'; a: number; b: number; dimension: string };

/**
 * A piece of the body the sketch measures against.
 *
 * It names an edge the way a fillet's selection does — by where the edge sits
 * in the body's bounding box — and says which of the sketch's points stand for
 * it. Those points are not solved for: they are put where the edge is, every
 * solve, and everything else moves around them. That is the whole of what makes
 * a dimension to the body follow the body.
 */
export type Reference =
  /** The two ends of an edge. A straight one has a reference line between them. */
  | { kind: 'ends'; a: number; b: number; edge: EdgeRef }
  /** The centre of a closed edge: the middle of a bore, not a point on its rim. */
  | { kind: 'centre'; point: number; edge: EdgeRef };

export interface Sketch {
  points: Point[];
  entities: Entity[];
  constraints: Constraint[];
  /** Absent on a sketch that refers to nothing, which is most of them. */
  refs?: Reference[];
}

export function refsOf(sketch: Sketch): readonly Reference[] {
  return sketch.refs ?? [];
}

export function pointsOfRef(ref: Reference): number[] {
  return ref.kind === 'ends' ? [ref.a, ref.b] : [ref.point];
}

/** The points the body places rather than the solver. */
export function fixedPoints(sketch: Sketch): Set<number> {
  const fixed = new Set<number>();
  for (const ref of refsOf(sketch)) for (const point of pointsOfRef(ref)) fixed.add(point);
  return fixed;
}

/** The reference line standing for a straight edge, if that reference has one. */
export function lineOfRef(sketch: Sketch, ref: Reference): number {
  if (ref.kind !== 'ends') return -1;
  return sketch.entities.findIndex(
    (entity) =>
      entity.kind === 'line' &&
      entity.reference === true &&
      ((entity.a === ref.a && entity.b === ref.b) || (entity.a === ref.b && entity.b === ref.a)),
  );
}

/** Every dimension name the sketch drives, in the order first mentioned. */
export function dimensionsOf(sketch: Sketch): string[] {
  const names: string[] = [];
  for (const constraint of sketch.constraints) {
    if (!('dimension' in constraint)) continue;
    if (!names.includes(constraint.dimension)) names.push(constraint.dimension);
  }
  return names;
}

export function lineOf(sketch: Sketch, index: number, role: string): Line {
  const entity = sketch.entities[index];
  if (entity === undefined) throw new Error(`${role} refers to entity ${index}, which is not there`);
  if (entity.kind !== 'line') throw new Error(`${role} needs a line, not a ${entity.kind}`);
  return entity;
}

export function circleOf(sketch: Sketch, index: number, role: string): Circle {
  const entity = sketch.entities[index];
  if (entity === undefined) throw new Error(`${role} refers to entity ${index}, which is not there`);
  if (entity.kind !== 'circle') throw new Error(`${role} needs a circle, not a ${entity.kind}`);
  return entity;
}

export function pointIndex(sketch: Sketch, index: number, role: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= sketch.points.length) {
    throw new Error(`${role} refers to point ${index}, which is not there`);
  }
  return index;
}

// ---------------------------------------------------------------- storage
//
// A sketch travels as plain nested arrays so it hashes, serialises and reaches
// the worker like any other node input. Decoding validates, because a document
// can be hand-edited and a malformed sketch should say so rather than solve to
// something surprising.

type Raw = unknown;

function asNumber(value: Raw, what: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`${what} is not a number`);
  return value;
}

function asIndex(value: Raw, what: string): number {
  const index = asNumber(value, what);
  if (!Number.isInteger(index) || index < 0) throw new Error(`${what} is not an index`);
  return index;
}

function asName(value: Raw, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${what} is not a name`);
  return value;
}

export function encodeSketch(sketch: Sketch): {
  points: number[];
  entities: Raw[][];
  constraints: Raw[][];
  refs: Raw[][];
} {
  return {
    points: sketch.points.flatMap((point) => [point.u, point.v]),
    entities: sketch.entities.map((entity) =>
      entity.kind === 'line'
        ? entity.reference === true
          ? ['line', entity.a, entity.b, 'reference']
          : ['line', entity.a, entity.b]
        : ['circle', entity.centre, entity.radius],
    ),
    refs: refsOf(sketch).map((ref) => {
      const edge = [
        ref.edge.fraction.x,
        ref.edge.fraction.y,
        ref.edge.fraction.z,
        ref.edge.direction.x,
        ref.edge.direction.y,
        ref.edge.direction.z,
        ref.edge.length,
      ];
      return ref.kind === 'ends' ? ['ends', ref.a, ref.b, ...edge] : ['centre', ref.point, ...edge];
    }),
    constraints: sketch.constraints.map((constraint) => {
      switch (constraint.kind) {
        case 'coincident':
        case 'parallel':
        case 'perpendicular':
        case 'equal':
        case 'concentric':
          return [constraint.kind, constraint.a, constraint.b];
        case 'horizontal':
        case 'vertical':
          return [constraint.kind, constraint.line];
        case 'pointOnLine':
        case 'midpoint':
          return [constraint.kind, constraint.point, constraint.line];
        case 'lockU':
        case 'lockV':
          return [constraint.kind, constraint.point, constraint.dimension];
        case 'radius':
          return [constraint.kind, constraint.circle, constraint.dimension];
        case 'lineDistance':
          return [constraint.kind, constraint.point, constraint.line, constraint.dimension];
        default:
          return [constraint.kind, constraint.a, constraint.b, constraint.dimension];
      }
    }),
  };
}

function asEdgeRef(row: readonly Raw[], from: number, what: string): EdgeRef {
  const n = (offset: number): number => asNumber(row[from + offset], what);
  return {
    fraction: { x: n(0), y: n(1), z: n(2) },
    direction: { x: n(3), y: n(4), z: n(5) },
    length: n(6),
  };
}

export function decodeSketch(points: Raw, entities: Raw, constraints: Raw, refs: Raw = []): Sketch {
  if (!Array.isArray(points)) throw new Error('Sketch points are missing');
  if (points.length % 2 !== 0) throw new Error('Sketch points must be pairs of U and V');
  const decodedPoints: Point[] = [];
  for (let i = 0; i < points.length; i += 2) {
    decodedPoints.push({
      u: asNumber(points[i], `Point ${i / 2 + 1} U`),
      v: asNumber(points[i + 1], `Point ${i / 2 + 1} V`),
    });
  }

  if (!Array.isArray(entities)) throw new Error('Sketch entities are missing');
  const decodedEntities: Entity[] = entities.map((row, index) => {
    if (!Array.isArray(row)) throw new Error(`Entity ${index + 1} is malformed`);
    const what = `Entity ${index + 1}`;
    if (row[0] === 'line') {
      const line: Line = { kind: 'line', a: asIndex(row[1], what), b: asIndex(row[2], what) };
      if (row[3] === 'reference') line.reference = true;
      return line;
    }
    if (row[0] === 'circle') {
      return { kind: 'circle', centre: asIndex(row[1], what), radius: asNumber(row[2], what) };
    }
    throw new Error(`${what} is a ${String(row[0])}, which is not a kind of entity`);
  });

  if (!Array.isArray(constraints)) throw new Error('Sketch constraints are missing');
  const decodedConstraints: Constraint[] = constraints.map((row, index) => {
    if (!Array.isArray(row)) throw new Error(`Constraint ${index + 1} is malformed`);
    const what = `Constraint ${index + 1}`;
    const kind = row[0];
    switch (kind) {
      case 'coincident':
      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'concentric':
        return { kind, a: asIndex(row[1], what), b: asIndex(row[2], what) };
      case 'horizontal':
      case 'vertical':
        return { kind, line: asIndex(row[1], what) };
      case 'pointOnLine':
      case 'midpoint':
        return { kind, point: asIndex(row[1], what), line: asIndex(row[2], what) };
      case 'lockU':
      case 'lockV':
        return { kind, point: asIndex(row[1], what), dimension: asName(row[2], what) };
      case 'radius':
        return { kind, circle: asIndex(row[1], what), dimension: asName(row[2], what) };
      case 'lineDistance':
        return {
          kind,
          point: asIndex(row[1], what),
          line: asIndex(row[2], what),
          dimension: asName(row[3], what),
        };
      case 'distance':
      case 'horizontalDistance':
      case 'verticalDistance':
      case 'angle':
        return {
          kind,
          a: asIndex(row[1], what),
          b: asIndex(row[2], what),
          dimension: asName(row[3], what),
        };
      default:
        throw new Error(`${what} is a ${String(kind)}, which is not a kind of constraint`);
    }
  });

  const sketch: Sketch = {
    points: decodedPoints,
    entities: decodedEntities,
    constraints: decodedConstraints,
  };

  if (!Array.isArray(refs)) throw new Error('Sketch references are malformed');
  if (refs.length > 0) {
    sketch.refs = refs.map((row, index): Reference => {
      if (!Array.isArray(row)) throw new Error(`Reference ${index + 1} is malformed`);
      const what = `Reference ${index + 1}`;
      const within = (value: Raw): number => {
        const point = asIndex(value, what);
        if (point >= decodedPoints.length) throw new Error(`${what} names a point that is not there`);
        return point;
      };
      if (row[0] === 'ends') {
        return { kind: 'ends', a: within(row[1]), b: within(row[2]), edge: asEdgeRef(row, 3, what) };
      }
      if (row[0] === 'centre') {
        return { kind: 'centre', point: within(row[1]), edge: asEdgeRef(row, 2, what) };
      }
      throw new Error(`${what} is a ${String(row[0])}, which is not a kind of reference`);
    });
  }

  return sketch;
}
