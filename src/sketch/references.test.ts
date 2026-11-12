import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/types.js';
import type { EdgeInfo } from '../geometry/kernel.js';
import { makePlane } from '../geometry/plane.js';
import type { Draft } from './draw.js';
import { addCircle, addPoint, onlyAboutTheBody, pruneReferences, removeParts } from './draw.js';
import { decodeSketch, encodeSketch, fixedPoints, refsOf } from './model.js';
import { addReference, isStraight, placeReferences, referenceAt, toPlane } from './references.js';
import { regionsOf } from './regions.js';
import { solveSketch } from './solver.js';

/** The top of a block `width` by `depth`, at height 20, with a bore in the middle. */
function topOf(width: number, depth: number): EdgeInfo[] {
  const box = { x: width, y: depth, z: 20 };
  const fractionOf = (p: Vec3): Vec3 => ({ x: p.x / box.x, y: p.y / box.y, z: p.z / box.z });

  const straight = (start: Vec3, end: Vec3): EdgeInfo => {
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: (start.z + end.z) / 2 };
    return {
      midpoint,
      fraction: fractionOf(midpoint),
      direction: { x: (end.x - start.x) / length, y: (end.y - start.y) / length, z: (end.z - start.z) / length },
      length,
      start,
      end,
      closed: false,
      centre: midpoint,
      segmentStart: 0,
      segmentCount: 1,
    };
  };

  const centre = { x: width / 2, y: depth / 2, z: 20 };
  const rim = { x: centre.x + 8, y: centre.y, z: 20 };
  const bore: EdgeInfo = {
    midpoint: centre,
    fraction: fractionOf(centre),
    direction: { x: 0, y: 0, z: 0 },
    length: 2 * Math.PI * 8,
    start: rim,
    end: rim,
    closed: true,
    centre,
    segmentStart: 0,
    segmentCount: 24,
  };

  return [
    straight({ x: 0, y: 0, z: 20 }, { x: 0, y: depth, z: 20 }), // left
    straight({ x: 0, y: 0, z: 20 }, { x: width, y: 0, z: 20 }), // front
    straight({ x: width, y: 0, z: 20 }, { x: width, y: depth, z: 20 }), // right
    straight({ x: 0, y: depth, z: 20 }, { x: width, y: depth, z: 20 }), // back
    bore,
    // Standing square to the face: it projects onto a corner and nothing more.
    straight({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 20 }),
    // The bottom of the left side, directly under the top one.
    straight({ x: 0, y: 0, z: 0 }, { x: 0, y: depth, z: 0 }),
  ];
}

/** A plane on the top face whose axes start at the block's own corner. */
const plane = makePlane({ x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });

function draft(): Draft {
  return { sketch: { points: [], entities: [], constraints: [] }, dimensions: new Map() };
}

describe('seeing the body from a sketch', () => {
  it('drops a model point onto the plane along its normal', () => {
    expect(toPlane(plane, { x: 12, y: 7, z: -40 })).toEqual({ u: 12, v: 7 });
  });

  it('takes an end over the edge it ends, as a point wins over a line', () => {
    const edges = topOf(60, 40);
    expect(referenceAt(edges, plane, { u: 0.3, v: 0.4 }, 1)?.part).toMatch(/start|end/);
    expect(referenceAt(edges, plane, { u: 0.3, v: 18 }, 1)).toEqual({ edge: 0, part: 'line' });
  });

  it('prefers the edge on the sketch plane to the one hidden under it', () => {
    // The top and bottom of the left side project onto the same line.
    expect(referenceAt(topOf(60, 40), plane, { u: 0, v: 18 }, 1)?.edge).toBe(0);
  });

  it('reads a click on the rim of a bore as its centre', () => {
    expect(referenceAt(topOf(60, 40), plane, { u: 38, v: 20 }, 1)).toEqual({ edge: 4, part: 'centre' });
  });

  it('offers nothing for an edge that stands square to the plane', () => {
    const upright = [topOf(60, 40)[5]!];
    expect(referenceAt(upright, plane, { u: 0, v: 0 }, 1)).toBeNull();
  });

  it('finds nothing where there is nothing', () => {
    expect(referenceAt(topOf(60, 40), plane, { u: 15, v: 9 }, 1)).toBeNull();
  });

  it('knows a straight edge from a curved one by its chord', () => {
    const [left] = topOf(60, 40);
    expect(isStraight(left!)).toBe(true);
    expect(isStraight({ ...left!, length: left!.length * 1.2 })).toBe(false);
  });
});

describe('laying an edge into a sketch', () => {
  it('adds its ends as points the body places, and a line that bounds nothing', () => {
    const d = draft();
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    const laid = addReference(d.sketch, topOf(60, 40)[0]!, plane);

    expect(laid.points).toHaveLength(2);
    expect([...fixedPoints(d.sketch)].sort()).toEqual(laid.points);
    expect(d.sketch.entities[laid.line]).toMatchObject({ kind: 'line', reference: true });
    // Only the circle is a region: the reference line is not a loose end.
    expect(regionsOf(d.sketch)).toHaveLength(1);
  });

  it('shares a corner between two edges that meet there', () => {
    const d = draft();
    const edges = topOf(60, 40);
    const left = addReference(d.sketch, edges[0]!, plane);
    const front = addReference(d.sketch, edges[1]!, plane);

    expect(front.points[0]).toBe(left.points[0]);
    expect(d.sketch.points).toHaveLength(3);
  });

  it('gives a closed edge one point, at its centre', () => {
    const d = draft();
    const laid = addReference(d.sketch, topOf(60, 40)[4]!, plane);

    expect(laid.line).toBe(-1);
    expect(d.sketch.points[laid.points[0]!]).toEqual({ u: 30, v: 20 });
  });

  it('survives being written down and read back', () => {
    const d = draft();
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    addReference(d.sketch, topOf(60, 40)[0]!, plane);
    addReference(d.sketch, topOf(60, 40)[4]!, plane);

    const stored = encodeSketch(d.sketch);
    const back = decodeSketch(stored.points, stored.entities, stored.constraints, stored.refs);
    expect(back).toEqual(d.sketch);
  });

  it('reads a sketch written before references existed', () => {
    expect(refsOf(decodeSketch([0, 0], [], []))).toEqual([]);
  });
});

describe('measuring from the body', () => {
  /** A circle, and the left edge of the block it sits on, 15 mm apart. */
  function measured(): { d: Draft; line: number; centre: number } {
    const d = draft();
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    const laid = addReference(d.sketch, topOf(60, 40)[0]!, plane);
    d.sketch.constraints = [{ kind: 'lineDistance', point: 0, line: laid.line, dimension: 'offset' }];
    d.dimensions = new Map([['offset', 15]]);
    return { d, line: laid.line, centre: 0 };
  }

  it('moves what was drawn and leaves the body where it is', () => {
    const { d } = measured();
    d.dimensions.set('offset', 22);
    const result = solveSketch(d.sketch, d.dimensions);

    expect(result.solved).toBe(true);
    expect(result.points[0]!.u).toBeCloseTo(22, 6);
    expect(result.points[1]).toEqual({ u: 0, v: 0 });
    expect(result.points[2]).toEqual({ u: 0, v: 40 });
  });

  it('does not count the body\'s points among what is left free', () => {
    const { d } = measured();
    // The circle may still slide along the edge and change its radius.
    expect(solveSketch(d.sketch, d.dimensions).freedom).toBe(2);
  });

  it('cannot be dragged by a point the body placed', () => {
    const { d } = measured();
    const result = solveSketch(d.sketch, d.dimensions, { pull: [{ point: 1, to: { u: 9, v: 9 } }] });
    expect(result.points[1]).toEqual({ u: 0, v: 0 });
  });

  it('follows the body when the body is resized', () => {
    const { d } = measured();
    // Twice as deep: the left edge is now twice as long.
    expect(placeReferences(d.sketch, topOf(60, 80), plane)).toEqual([]);
    expect(d.sketch.points[2]).toEqual({ u: 0, v: 80 });
  });

  it('follows the body when the plane it is seen from moves', () => {
    const { d } = measured();
    // The face's own origin is its middle, which moves when the block widens.
    const shifted = makePlane({ x: 10, y: 0, z: 20 }, { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 });
    placeReferences(d.sketch, topOf(60, 40), shifted);
    const result = solveSketch(d.sketch, d.dimensions);

    // Still 15 mm from the edge, which is now at U = -10.
    expect(result.points[1]!.u).toBeCloseTo(-10, 9);
    expect(result.points[0]!.u).toBeCloseTo(5, 6);
  });

  it('says which reference has lost its edge', () => {
    const { d } = measured();
    const withoutLeft = topOf(60, 40).filter((_, index) => index !== 0 && index !== 6);
    expect(placeReferences(d.sketch, withoutLeft, plane)).toEqual([0]);
  });

  it('will not take a rim for a span, or a span for a rim', () => {
    const d = draft();
    addReference(d.sketch, topOf(60, 40)[4]!, plane);
    // Only straight edges left where the bore was looked for.
    const noBore = topOf(60, 40).filter((edge) => !edge.closed);
    expect(placeReferences(d.sketch, noBore, plane)).toEqual([0]);
  });

  it('knows a rule that is only about the body from one that is not', () => {
    const { d, line } = measured();
    expect(onlyAboutTheBody(d.sketch, { kind: 'distance', a: 1, b: 2, dimension: 'x' })).toBe(true);
    expect(onlyAboutTheBody(d.sketch, { kind: 'horizontal', line })).toBe(true);
    expect(onlyAboutTheBody(d.sketch, { kind: 'distance', a: 0, b: 2, dimension: 'x' })).toBe(false);
    expect(onlyAboutTheBody(d.sketch, d.sketch.constraints[0]!)).toBe(false);
  });
});

describe('letting go of the body', () => {
  it('takes out an edge nothing measures from, and keeps one something does', () => {
    const d = draft();
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    const edges = topOf(60, 40);
    const left = addReference(d.sketch, edges[0]!, plane);
    addReference(d.sketch, edges[2]!, plane);
    d.sketch.constraints.push({ kind: 'lineDistance', point: 0, line: left.line, dimension: 'offset' });
    d.dimensions.set('offset', 15);

    expect(pruneReferences(d)).toBe(true);
    expect(refsOf(d.sketch)).toHaveLength(1);
    expect(d.sketch.points).toHaveLength(3);
    // The rule that survives still points at the edge it was about.
    const rule = d.sketch.constraints.find((entry) => entry.kind === 'lineDistance');
    expect(rule).toMatchObject({ point: 0 });
    expect(d.sketch.entities[(rule as { line: number }).line]).toMatchObject({ reference: true });
  });

  it('keeps the corner two edges share when only one of them goes', () => {
    const d = draft();
    const edges = topOf(60, 40);
    const left = addReference(d.sketch, edges[0]!, plane);
    const front = addReference(d.sketch, edges[1]!, plane);
    addPoint(d, { u: 20, v: 10 }, 0.5);
    d.sketch.constraints.push({
      kind: 'lineDistance',
      point: d.sketch.points.length - 1,
      line: front.line,
      dimension: 'up',
    });
    d.dimensions.set('up', 10);

    pruneReferences(d);
    expect(refsOf(d.sketch)).toHaveLength(1);
    expect(left.points[0]).toBe(front.points[0]);
    // The front edge still has both its ends.
    expect(fixedPoints(d.sketch).size).toBe(2);
    expect(solveSketch(d.sketch, d.dimensions).solved).toBe(true);
  });

  it('takes the whole reference when one of its points is deleted', () => {
    const d = draft();
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    const laid = addReference(d.sketch, topOf(60, 40)[0]!, plane);

    removeParts(d, [], [laid.points[0]!]);
    expect(refsOf(d.sketch)).toEqual([]);
    expect(d.sketch.points).toHaveLength(1);
    expect(d.sketch.entities).toHaveLength(1);
  });

  it('pins a sketch down again once nothing ties it to the body', () => {
    const d = draft();
    addReference(d.sketch, topOf(60, 40)[0]!, plane);
    addCircle(d, { u: 15, v: 12 }, 4, 0.5);
    // Drawn against the body, it was not given an origin lock of its own.
    expect(d.sketch.constraints).toEqual([]);

    pruneReferences(d);
    expect(d.sketch.constraints.map((rule) => rule.kind)).toEqual(['lockU', 'lockV']);
  });
});
