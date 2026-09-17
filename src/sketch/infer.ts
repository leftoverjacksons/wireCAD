import type { Constraint, Point, Sketch } from './model.js';

/** Within this, in millimetres, a drawn edge was meant to be axis-aligned. */
const STRAIGHT = 1e-6;

/**
 * Turns a drawn shape into a constrained one.
 *
 * Only what the drawing actually shows is asserted. An edge drawn flat becomes
 * horizontal; the first point is locked so the sketch has somewhere to be; and a
 * shape recognisably a rectangle or a circle gets the dimensions everyone would
 * name it by. A general polygon gets no lengths at all, because guessing them
 * would put contradictions in a sketch nobody asked to over-constrain — it comes
 * out under-constrained, which is what a freshly drawn sketch honestly is.
 */
export function inferSketch(points: readonly Point[]): Sketch {
  const sketch: Sketch = {
    points: points.map((point) => ({ ...point })),
    entities: points.map((_, index) => ({
      kind: 'line' as const,
      a: index,
      b: (index + 1) % points.length,
    })),
    constraints: [],
  };

  const constraints: Constraint[] = [
    { kind: 'lockU', point: 0, dimension: 'originU' },
    { kind: 'lockV', point: 0, dimension: 'originV' },
  ];

  for (const [index, entity] of sketch.entities.entries()) {
    if (entity.kind !== 'line') continue;
    const from = sketch.points[entity.a]!;
    const to = sketch.points[entity.b]!;
    if (Math.abs(to.v - from.v) < STRAIGHT) constraints.push({ kind: 'horizontal', line: index });
    else if (Math.abs(to.u - from.u) < STRAIGHT) constraints.push({ kind: 'vertical', line: index });
  }

  if (isAxisAlignedRectangle(sketch.points)) {
    // Opposite sides follow from the four horizontal and vertical relations, so
    // two dimensions is exactly enough and a third would fight them.
    constraints.push(
      { kind: 'horizontalDistance', a: 0, b: 1, dimension: 'width' },
      { kind: 'verticalDistance', a: 0, b: 3, dimension: 'height' },
    );
  }

  sketch.constraints = constraints;
  return sketch;
}

/** A circle is its own sketch: a centre that is pinned and a radius that is named. */
export function inferCircle(centre: Point, radius: number): Sketch {
  return {
    points: [{ ...centre }],
    entities: [{ kind: 'circle', centre: 0, radius }],
    constraints: [
      { kind: 'lockU', point: 0, dimension: 'centreU' },
      { kind: 'lockV', point: 0, dimension: 'centreV' },
      { kind: 'radius', circle: 0, dimension: 'radius' },
    ],
  };
}

/** The starting values for the dimensions a drawn sketch names. */
export function inferDimensions(sketch: Sketch, points: readonly Point[], radius = 0): number[] {
  const first = points[0] ?? { u: 0, v: 0 };
  const out: Array<string | number> = [];

  for (const constraint of sketch.constraints) {
    if (!('dimension' in constraint)) continue;
    switch (constraint.dimension) {
      case 'originU':
      case 'centreU':
        out.push(constraint.dimension, first.u);
        break;
      case 'originV':
      case 'centreV':
        out.push(constraint.dimension, first.v);
        break;
      case 'radius':
        out.push('radius', radius);
        break;
      case 'width':
        out.push('width', Math.abs((points[1]?.u ?? 0) - first.u));
        break;
      case 'height':
        out.push('height', Math.abs((points[3]?.v ?? 0) - first.v));
        break;
      default:
        break;
    }
  }

  return out as number[];
}

function isAxisAlignedRectangle(points: readonly Point[]): boolean {
  if (points.length !== 4) return false;

  const us = points.map((point) => point.u);
  const vs = points.map((point) => point.v);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  if (maxU - minU < STRAIGHT || maxV - minV < STRAIGHT) return false;

  const corners = new Set<string>();
  for (const point of points) {
    const onU = Math.abs(point.u - minU) < STRAIGHT || Math.abs(point.u - maxU) < STRAIGHT;
    const onV = Math.abs(point.v - minV) < STRAIGHT || Math.abs(point.v - maxV) < STRAIGHT;
    if (!onU || !onV) return false;
    corners.add(`${Math.abs(point.u - minU) < STRAIGHT ? 0 : 1}${Math.abs(point.v - minV) < STRAIGHT ? 0 : 1}`);
  }
  return corners.size === 4;
}
