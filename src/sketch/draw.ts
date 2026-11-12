import type { Constraint, Point, Reference, Sketch } from './model.js';
import { fixedPoints, lineOfRef, pointsOfRef, refsOf } from './model.js';

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
  // A sketch that measures from the body is somewhere already. Locking it down
  // as well would fight the first dimension that says where it really is.
  if (refsOf(sketch).length > 0) return;

  sketch.constraints.push(
    { kind: 'lockU', point: 0, dimension: 'originU' },
    { kind: 'lockV', point: 0, dimension: 'originV' },
  );
  draft.dimensions.set('originU', at.u);
  draft.dimensions.set('originV', at.v);
}

/** An edge between two points, or the one already there. Null if it would be degenerate. */
export function addLine(draft: Draft, a: number, b: number): number | null {
  if (a === b) return null;

  const existing = draft.sketch.entities.findIndex(
    (entity) =>
      entity.kind === 'line' &&
      ((entity.a === a && entity.b === b) || (entity.a === b && entity.b === a)),
  );
  if (existing >= 0) return existing;

  draft.sketch.entities.push({ kind: 'line', a, b });
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
export function addRectangle(draft: Draft, from: Point, to: Point, slack: number): number[] {
  const corners = [
    { u: from.u, v: from.v },
    { u: to.u, v: from.v },
    { u: to.u, v: to.v },
    { u: from.u, v: to.v },
  ].map((corner) => addPoint(draft, corner, slack));

  const edges: number[] = [];
  for (let i = 0; i < 4; i++) {
    const edge = addLine(draft, corners[i]!, corners[(i + 1) % 4]!);
    if (edge !== null) edges.push(edge);
  }
  return edges;
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
  /** References to take out by name, rather than by asking for their points. */
  references: readonly number[] = [],
): void {
  const sketch = draft.sketch;
  const droppedEntities = new Set(entities);
  const droppedPoints = new Set(points);

  // A reference goes whole or not at all: asked to give up its line or one of
  // its points, it takes the rest of itself with it, because half of an edge of
  // the body is not a thing a sketch can be left holding.
  const refs = refsOf(sketch);
  const droppedRefs = new Set<number>(references);
  // Decided against what was asked for, before any reference adds its own
  // points to the list: otherwise one going would take every reference that
  // shares a corner with it, and those would take the ones they share with.
  const askedPoints = new Set(droppedPoints);
  for (const [index, ref] of refs.entries()) {
    const line = lineOfRef(sketch, ref);
    if (
      (line >= 0 && droppedEntities.has(line)) ||
      pointsOfRef(ref).some((point) => askedPoints.has(point))
    ) {
      droppedRefs.add(index);
    }
  }
  for (const index of droppedRefs) {
    const ref = refs[index];
    if (ref === undefined) continue;
    const line = lineOfRef(sketch, ref);
    if (line >= 0) droppedEntities.add(line);
    for (const point of pointsOfRef(ref)) droppedPoints.add(point);
  }
  // Two edges that meet share a corner, and the one that stays still needs it.
  for (const [index, ref] of refs.entries()) {
    if (droppedRefs.has(index)) continue;
    for (const point of pointsOfRef(ref)) droppedPoints.delete(point);
  }

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

  if (refs.length > 0) {
    const kept = refs
      .filter((_, index) => !droppedRefs.has(index))
      .map(
        (ref): Reference =>
          ref.kind === 'ends'
            ? { ...ref, a: pointMap[ref.a]!, b: pointMap[ref.b]! }
            : { ...ref, point: pointMap[ref.point]! },
      );
    if (kept.length > 0) sketch.refs = kept;
    else delete sketch.refs;
  }

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
    case 'lineDistance':
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

/** The points and entities a rule is about. */
export function usesOf(constraint: Constraint): { points: number[]; entities: number[] } {
  switch (constraint.kind) {
    case 'horizontal':
    case 'vertical':
      return { points: [], entities: [constraint.line] };
    case 'radius':
      return { points: [], entities: [constraint.circle] };
    case 'pointOnLine':
    case 'midpoint':
    case 'lineDistance':
      return { points: [constraint.point], entities: [constraint.line] };
    case 'lockU':
    case 'lockV':
      return { points: [constraint.point], entities: [] };
    case 'parallel':
    case 'perpendicular':
    case 'equal':
    case 'concentric':
    case 'angle':
      return { points: [], entities: [constraint.a, constraint.b] };
    default:
      return { points: [constraint.a, constraint.b], entities: [] };
  }
}

/** Every point a rule reaches, through the entities it names as well as directly. */
export function pointsUnder(sketch: Sketch, constraint: Constraint): number[] {
  const uses = usesOf(constraint);
  const out = [...uses.points];
  for (const index of uses.entities) {
    const entity = sketch.entities[index];
    if (entity === undefined) continue;
    if (entity.kind === 'circle') out.push(entity.centre);
    else out.push(entity.a, entity.b);
  }
  return out;
}

/**
 * True when a rule is only about the body: every point it reaches is one the
 * body places. Such a rule can change nothing — it either repeats what the body
 * already says or contradicts it — so it is not one a sketch should hold.
 */
export function onlyAboutTheBody(sketch: Sketch, constraint: Constraint): boolean {
  const fixed = fixedPoints(sketch);
  if (fixed.size === 0) return false;
  if (constraint.kind === 'radius') return false;
  const reached = pointsUnder(sketch, constraint);
  return reached.length > 0 && reached.every((point) => fixed.has(point));
}

/**
 * Takes out the references nothing is using.
 *
 * A reference is made by clicking an edge, which is also how a person finds out
 * what is there to click. Whatever was laid in and then never measured from
 * would otherwise stay in the sketch for good, tying it to edges it has no
 * interest in — and failing the sketch on the day one of them is filleted away.
 */
export function pruneReferences(draft: Draft): boolean {
  const sketch = draft.sketch;
  const refs = refsOf(sketch);
  if (refs.length === 0) return false;

  const usedPoints = new Set<number>();
  const usedEntities = new Set<number>();
  for (const constraint of sketch.constraints) {
    const uses = usesOf(constraint);
    for (const point of uses.points) usedPoints.add(point);
    for (const entity of uses.entities) usedEntities.add(entity);
  }
  for (const entity of sketch.entities) {
    if (entity.kind === 'circle') usedPoints.add(entity.centre);
    else if (entity.reference !== true) {
      usedPoints.add(entity.a);
      usedPoints.add(entity.b);
    }
  }

  const unused: number[] = [];
  for (const [index, ref] of refs.entries()) {
    const line = lineOfRef(sketch, ref);
    if (line >= 0 && usedEntities.has(line)) continue;
    if (pointsOfRef(ref).some((point) => usedPoints.has(point))) continue;
    unused.push(index);
  }
  if (unused.length === 0) return false;

  // By name, not by their points: a corner shared with a reference that is
  // still in use has to stay, and asking for the point would take both.
  removeParts(draft, [], [], unused);
  return true;
}
