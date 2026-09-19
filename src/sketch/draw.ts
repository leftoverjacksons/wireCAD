import type { Constraint, Point, Sketch } from './model.js';

/** Within this, in millimetres, a drawn edge was meant to be axis-aligned. */
const STRAIGHT = 1e-6;

/**
 * A sketch being drawn: the model, and the numbers its dimensions currently
 * hold. Drawing appends to both.
 *
 * What gets asserted is only what the drawing shows — an edge drawn flat is
 * horizontal, a line started on an existing point shares that point — and never
 * a length. Lengths come from the dimension tool, so a freshly drawn sketch is
 * under-constrained, which is what it honestly is.
 */
export interface Draft {
  sketch: Sketch;
  dimensions: Map<string, number>;
}

/** A name not already spoken for: `length1`, then `length2`, and so on. */
export function uniqueName(dimensions: ReadonlyMap<string, number>, stem: string): string {
  let n = 1;
  while (dimensions.has(`${stem}${n}`)) n += 1;
  return `${stem}${n}`;
}

/**
 * The point at `at`, reusing one already within `slack` of it. Reuse is how
 * drawn things join: two edges through the same point share its index, so they
 * stay joined through every later solve without a rule saying so.
 */
export function addPoint(draft: Draft, at: Point, slack: number): number {
  let best = -1;
  let bestDistance = slack;
  for (const [index, point] of draft.sketch.points.entries()) {
    const distance = Math.hypot(point.u - at.u, point.v - at.v);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  if (best >= 0) return best;

  draft.sketch.points.push({ ...at });
  ensureAnchor(draft);
  return draft.sketch.points.length - 1;
}

/**
 * A sketch with anything in it needs somewhere to be: one point locked down, so
 * a solve cannot slide the whole drawing sideways. Nothing else says where it
 * is, and the lock is a pair of dimensions like any other, so it can still be
 * typed in or driven from elsewhere.
 */
export function ensureAnchor(draft: Draft): void {
  const sketch = draft.sketch;
  const at = sketch.points[0];
  if (at === undefined) return;
  if (sketch.constraints.some((rule) => rule.kind === 'lockU' || rule.kind === 'lockV')) return;

  sketch.constraints.push(
    { kind: 'lockU', point: 0, dimension: 'originU' },
    { kind: 'lockV', point: 0, dimension: 'originV' },
  );
  draft.dimensions.set('originU', at.u);
  draft.dimensions.set('originV', at.v);
}

/**
 * An edge between two points, or the one already there. Null if it would be
 * degenerate.
 *
 * An edge already drawn between the two points is handed back as it stands,
 * construction or not: drawing over something gives you the thing that is
 * there, and quietly changing what it is would be a surprise from a gesture
 * that looks like a no-op.
 */
export function addLine(draft: Draft, a: number, b: number, construction = false): number | null {
  if (a === b) return null;

  const existing = draft.sketch.entities.findIndex(
    (entity) =>
      entity.kind === 'line' &&
      ((entity.a === a && entity.b === b) || (entity.a === b && entity.b === a)),
  );
  if (existing >= 0) return existing;

  draft.sketch.entities.push(
    construction ? { kind: 'line', a, b, construction } : { kind: 'line', a, b },
  );
  const index = draft.sketch.entities.length - 1;

  const from = draft.sketch.points[a]!;
  const to = draft.sketch.points[b]!;
  const relation: Constraint | null =
    Math.abs(to.v - from.v) < STRAIGHT
      ? { kind: 'horizontal', line: index }
      : Math.abs(to.u - from.u) < STRAIGHT
        ? { kind: 'vertical', line: index }
        : null;
  if (relation !== null) draft.sketch.constraints.push(relation);

  return index;
}

/** The four corners and four edges of a rectangle drawn corner to corner. */
export function addRectangle(
  draft: Draft,
  from: Point,
  to: Point,
  slack: number,
  construction = false,
): number[] {
  const corners = [
    { u: from.u, v: from.v },
    { u: to.u, v: from.v },
    { u: to.u, v: to.v },
    { u: from.u, v: to.v },
  ].map((corner) => addPoint(draft, corner, slack));

  const edges: number[] = [];
  for (let i = 0; i < 4; i++) {
    const edge = addLine(draft, corners[i]!, corners[(i + 1) % 4]!, construction);
    if (edge !== null) edges.push(edge);
  }
  return edges;
}

/**
 * Makes the lines among `entities` construction, or ordinary again, and says
 * how many changed.
 *
 * Only lines: a circle is either a region or nothing, and a construction circle
 * is not something this sketch knows how to be. Every rule holding the line
 * stays exactly as it is — what changes is whether the profile is built from
 * it, not what it is or where.
 */
export function setConstruction(
  draft: Draft,
  entities: readonly number[],
  construction: boolean,
): number {
  let changed = 0;
  for (const index of entities) {
    const entity = draft.sketch.entities[index];
    if (entity === undefined || entity.kind !== 'line') continue;
    if ((entity.construction === true) === construction) continue;

    if (construction) entity.construction = true;
    else delete entity.construction;
    changed += 1;
  }
  return changed;
}

export function addCircle(draft: Draft, centre: Point, radius: number, slack: number): number {
  const index = addPoint(draft, centre, slack);
  draft.sketch.entities.push({ kind: 'circle', centre: index, radius });
  return draft.sketch.entities.length - 1;
}

/**
 * Removes entities and points, and every rule that referred to them.
 *
 * Indices shift when something is removed from the middle, and constraints hold
 * indices, so everything that survives is renumbered here. Doing it in one pass
 * is what keeps a delete from silently repointing a rule at its neighbour.
 */
export function removeParts(
  draft: Draft,
  entities: readonly number[],
  points: readonly number[],
): void {
  const sketch = draft.sketch;
  const droppedEntities = new Set(entities);
  const droppedPoints = new Set(points);

  // A point an edge still needs cannot go; the edge would be left dangling.
  for (const [index, entity] of sketch.entities.entries()) {
    if (droppedEntities.has(index)) continue;
    if (entity.kind === 'circle') droppedPoints.delete(entity.centre);
    else {
      droppedPoints.delete(entity.a);
      droppedPoints.delete(entity.b);
    }
  }

  const entityMap = renumber(sketch.entities.length, droppedEntities);
  const pointMap = renumber(sketch.points.length, droppedPoints);

  sketch.entities = sketch.entities
    .filter((_, index) => !droppedEntities.has(index))
    .map((entity) =>
      entity.kind === 'circle'
        ? { ...entity, centre: pointMap[entity.centre]! }
        : { ...entity, a: pointMap[entity.a]!, b: pointMap[entity.b]! },
    );
  sketch.points = sketch.points.filter((_, index) => !droppedPoints.has(index));

  sketch.constraints = sketch.constraints
    .map((constraint) => remap(constraint, entityMap, pointMap, droppedEntities, droppedPoints))
    .filter((constraint): constraint is Constraint => constraint !== null);

  const alive = new Set(
    sketch.constraints.filter((c) => 'dimension' in c).map((c) => (c as { dimension: string }).dimension),
  );
  for (const name of [...draft.dimensions.keys()]) {
    if (!alive.has(name)) draft.dimensions.delete(name);
  }

  ensureAnchor(draft);
}

/** Old index to new, for a list with some entries removed. */
function renumber(length: number, dropped: ReadonlySet<number>): number[] {
  const map: number[] = [];
  let next = 0;
  for (let index = 0; index < length; index++) {
    map[index] = dropped.has(index) ? -1 : next++;
  }
  return map;
}

function remap(
  constraint: Constraint,
  entityMap: readonly number[],
  pointMap: readonly number[],
  droppedEntities: ReadonlySet<number>,
  droppedPoints: ReadonlySet<number>,
): Constraint | null {
  switch (constraint.kind) {
    case 'horizontal':
    case 'vertical':
      if (droppedEntities.has(constraint.line)) return null;
      return { ...constraint, line: entityMap[constraint.line]! };
    case 'radius':
      if (droppedEntities.has(constraint.circle)) return null;
      return { ...constraint, circle: entityMap[constraint.circle]! };
    case 'pointOnLine':
    case 'midpoint':
      if (droppedEntities.has(constraint.line) || droppedPoints.has(constraint.point)) return null;
      return { ...constraint, line: entityMap[constraint.line]!, point: pointMap[constraint.point]! };
    case 'lockU':
    case 'lockV':
      if (droppedPoints.has(constraint.point)) return null;
      return { ...constraint, point: pointMap[constraint.point]! };
    case 'parallel':
    case 'perpendicular':
    case 'equal':
    case 'concentric':
    case 'angle':
      if (droppedEntities.has(constraint.a) || droppedEntities.has(constraint.b)) return null;
      return { ...constraint, a: entityMap[constraint.a]!, b: entityMap[constraint.b]! };
    default:
      if (droppedPoints.has(constraint.a) || droppedPoints.has(constraint.b)) return null;
      return { ...constraint, a: pointMap[constraint.a]!, b: pointMap[constraint.b]! };
  }
}
