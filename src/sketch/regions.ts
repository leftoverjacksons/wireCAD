import type { Line, Point, Sketch } from './model.js';

/**
 * A closed area a sketch's entities bound. A sketch is no longer one profile:
 * it can hold several loops and circles, and which of them is a hole in which
 * is decided by where they sit, not by the order they were drawn.
 */
export type Region =
  | { kind: 'circle'; entity: number; centre: number }
  | { kind: 'loop'; entities: number[]; points: number[] };

/**
 * The closed regions the sketch bounds.
 *
 * Every circle is a region of its own. Lines have to form closed loops: each
 * point they meet at joins exactly two of them, which is what makes the walk
 * below unambiguous and what a face can actually be built from. A loose end or
 * a branch is reported rather than guessed at.
 */
export function regionsOf(sketch: Sketch): Region[] {
  const regions: Region[] = [];
  const lineIndices: number[] = [];

  for (const [index, entity] of sketch.entities.entries()) {
    if (entity.kind === 'circle') regions.push({ kind: 'circle', entity: index, centre: entity.centre });
    else lineIndices.push(index);
  }

  const meeting = new Map<number, number[]>();
  for (const index of lineIndices) {
    const line = sketch.entities[index] as Line;
    if (line.a === line.b) throw new Error(`Edge ${index + 1} starts and ends at the same point`);
    for (const point of [line.a, line.b]) {
      const list = meeting.get(point);
      if (list === undefined) meeting.set(point, [index]);
      else list.push(index);
    }
  }

  for (const [point, list] of meeting) {
    if (list.length === 1) {
      throw new Error(`Point ${point + 1} is a loose end — every edge has to meet another`);
    }
    if (list.length > 2) {
      throw new Error(`Point ${point + 1} joins ${list.length} edges, and a profile cannot branch`);
    }
  }

  const walked = new Set<number>();
  for (const start of lineIndices) {
    if (walked.has(start)) continue;

    const first = sketch.entities[start] as Line;
    const points = [first.a];
    const entities = [start];
    walked.add(start);

    let at = first.b;
    while (at !== points[0]) {
      points.push(at);
      const next = meeting.get(at)!.find((index) => !walked.has(index));
      if (next === undefined) throw new Error('These edges do not close into a loop');
      walked.add(next);
      entities.push(next);
      const line = sketch.entities[next] as Line;
      at = line.a === at ? line.b : line.a;
    }

    if (points.length < 3) throw new Error('A closed loop needs at least three edges');
    regions.push({ kind: 'loop', entities, points });
  }

  return regions;
}

/**
 * Twice the area the points enclose, positive when they run anticlockwise.
 *
 * Which way round a loop runs is not something a drawing decides — you can
 * trace a rectangle either way — but a face needs its boundary anticlockwise
 * and its holes clockwise, so the sign is what tells a wire which it is.
 */
export function signedArea(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    total += points[j]!.u * points[i]!.v - points[i]!.u * points[j]!.v;
  }
  return total;
}

/**
 * A point on the region's own boundary. A boundary point is what places one
 * region inside another: a centre would not, because the centre of the outer of
 * two circles about the same point lies inside the inner one as well.
 */
function representative(region: Region, points: readonly Point[], radii: readonly number[]): Point {
  if (region.kind !== 'circle') return points[region.points[0]!]!;
  const centre = points[region.centre]!;
  return { u: centre.u + radii[region.entity]!, v: centre.v };
}

function contains(
  region: Region,
  at: Point,
  points: readonly Point[],
  radii: readonly number[],
): boolean {
  if (region.kind === 'circle') {
    const centre = points[region.centre]!;
    return Math.hypot(at.u - centre.u, at.v - centre.v) < radii[region.entity]!;
  }

  // Even-odd ray cast along +U.
  let inside = false;
  const loop = region.points;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = points[loop[i]!]!;
    const b = points[loop[j]!]!;
    if (a.v > at.v === b.v > at.v) continue;
    if (at.u < ((b.u - a.u) * (at.v - a.v)) / (b.v - a.v) + a.u) inside = !inside;
  }
  return inside;
}

export interface Nesting {
  /** Index into the region list of the region bounding this face. */
  outer: number;
  /** Regions immediately inside it, which become holes. */
  holes: number[];
}

/**
 * Sorts regions into faces and the holes in them.
 *
 * Depth is how many regions a region sits inside. An even depth bounds material
 * and an odd one takes it away, so a ring drawn inside a hole is solid again —
 * the rule everyone already expects from nested outlines.
 */
export function nestRegions(
  regions: readonly Region[],
  points: readonly Point[],
  radii: readonly number[],
): Nesting[] {
  const depth: number[] = [];
  const parent: number[] = [];

  for (const [index, region] of regions.entries()) {
    const at = representative(region, points, radii);
    let deepest = -1;
    let count = 0;

    for (const [other, candidate] of regions.entries()) {
      if (other === index) continue;
      if (!contains(candidate, at, points, radii)) continue;
      count += 1;
      if (deepest < 0 || containedIn(candidate, regions[deepest]!, points, radii)) deepest = other;
    }

    depth[index] = count;
    parent[index] = deepest;
  }

  const faces: Nesting[] = [];
  const slot = new Map<number, number>();
  for (const [index] of regions.entries()) {
    if (depth[index]! % 2 !== 0) continue;
    slot.set(index, faces.length);
    faces.push({ outer: index, holes: [] });
  }

  for (const [index] of regions.entries()) {
    if (depth[index]! % 2 === 0) continue;
    const owner = slot.get(parent[index]!);
    if (owner === undefined) continue;
    faces[owner]!.holes.push(index);
  }

  return faces;
}

/** True when `inner` sits inside `outer`, used to find the closest container. */
function containedIn(
  inner: Region,
  outer: Region,
  points: readonly Point[],
  radii: readonly number[],
): boolean {
  return contains(outer, representative(inner, points, radii), points, radii);
}
