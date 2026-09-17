/**
 * A constrained sketch: points, the entities joining them, and the rules those
 * have to satisfy. Everything here is plain data so it hashes, serialises and
 * travels to the worker like any other node input.
 *
 * Positions are in the sketch plane's own U/V axes, in millimetres.
 */

export interface Point {
  u: number;
  v: number;
}

/** A straight edge between two points, by index into the point list. */
export interface Line {
  kind: 'line';
  a: number;
  b: number;
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
  | { kind: 'radius'; circle: number; dimension: string }
  | { kind: 'angle'; a: number; b: number; dimension: string };

export interface Sketch {
  points: Point[];
  entities: Entity[];
  constraints: Constraint[];
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
} {
  return {
    points: sketch.points.flatMap((point) => [point.u, point.v]),
    entities: sketch.entities.map((entity) =>
      entity.kind === 'line'
        ? ['line', entity.a, entity.b]
        : ['circle', entity.centre, entity.radius],
    ),
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
        default:
          return [constraint.kind, constraint.a, constraint.b, constraint.dimension];
      }
    }),
  };
}

export function decodeSketch(points: Raw, entities: Raw, constraints: Raw): Sketch {
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
    if (row[0] === 'line') return { kind: 'line', a: asIndex(row[1], what), b: asIndex(row[2], what) };
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

  return { points: decodedPoints, entities: decodedEntities, constraints: decodedConstraints };
}

/**
 * The points of a closed loop of lines, in order. Null when the lines do not
 * form exactly one closed loop, which is what a profile has to be.
 */
export function loopOrder(sketch: Sketch): number[] | null {
  const lines = sketch.entities.filter((entity): entity is Line => entity.kind === 'line');
  if (lines.length !== sketch.entities.length || lines.length < 3) return null;

  const remaining = [...lines];
  const first = remaining.shift()!;
  const order = [first.a, first.b];

  while (remaining.length > 0) {
    const tail = order[order.length - 1]!;
    const index = remaining.findIndex((line) => line.a === tail || line.b === tail);
    if (index < 0) return null;

    const [line] = remaining.splice(index, 1);
    order.push(line!.a === tail ? line!.b : line!.a);
  }

  // The walk must come back to where it started, and visit each point once.
  if (order[order.length - 1] !== order[0]) return null;
  order.pop();
  return new Set(order).size === order.length ? order : null;
}
