import type { Constraint, Point, Sketch } from './model.js';
import { circleOf, lineOf, pointIndex } from './model.js';

/**
 * Solves a sketch by least squares.
 *
 * Every constraint contributes one or two residuals — numbers that are zero when
 * it is satisfied — and the solver moves the points and radii until they all
 * are. Levenberg-Marquardt is the method: Gauss-Newton where that converges,
 * damped towards gradient descent where it does not, which is what keeps a
 * half-drawn sketch from flying apart on the first step.
 *
 * Sketches are small — tens of unknowns — so the Jacobian is dense and built by
 * finite differences. That costs one residual evaluation per unknown per
 * iteration and saves hand-differentiating every constraint, which is where a
 * solver of this kind usually goes quietly wrong.
 */

export interface SolveResult {
  points: Point[];
  radii: number[];
  /** True when every constraint is satisfied to `tolerance`. */
  solved: boolean;
  /** Largest single residual left, in millimetres or radians. */
  worst: number;
  iterations: number;
  /** Unknowns the constraints do not pin down. Zero means fully constrained. */
  freedom: number;
  /** Constraints that duplicate or fight others, by count of redundant rows. */
  redundant: number;
}

export interface SolveOptions {
  tolerance?: number;
  maxIterations?: number;
}

const EPSILON = 1e-9;

interface Layout {
  /** Unknown index of each point's U; V follows immediately after. */
  pointAt: number[];
  /** Unknown index of each circle entity's radius, by entity index. */
  radiusAt: Map<number, number>;
  size: number;
}

function layoutOf(sketch: Sketch): Layout {
  const pointAt = sketch.points.map((_, index) => index * 2);
  let next = sketch.points.length * 2;

  const radiusAt = new Map<number, number>();
  for (const [index, entity] of sketch.entities.entries()) {
    if (entity.kind !== 'circle') continue;
    radiusAt.set(index, next);
    next += 1;
  }

  return { pointAt, radiusAt, size: next };
}

function pack(sketch: Sketch, layout: Layout): number[] {
  const x = new Array<number>(layout.size).fill(0);
  for (const [index, point] of sketch.points.entries()) {
    x[layout.pointAt[index]!] = point.u;
    x[layout.pointAt[index]! + 1] = point.v;
  }
  for (const [entity, slot] of layout.radiusAt) {
    x[slot] = circleOf(sketch, entity, 'a circle').radius;
  }
  return x;
}

interface Vec {
  u: number;
  v: number;
}

function at(x: readonly number[], layout: Layout, point: number): Vec {
  const slot = layout.pointAt[point]!;
  return { u: x[slot]!, v: x[slot + 1]! };
}

function direction(x: readonly number[], layout: Layout, sketch: Sketch, line: number): Vec {
  const { a, b } = lineOf(sketch, line, 'a relation');
  const from = at(x, layout, a);
  const to = at(x, layout, b);
  return { u: to.u - from.u, v: to.v - from.v };
}

function norm(v: Vec): number {
  return Math.hypot(v.u, v.v);
}

/** Zero when the constraint holds. Two entries for constraints that pin a point. */
function residualsOf(
  constraint: Constraint,
  sketch: Sketch,
  layout: Layout,
  x: readonly number[],
  dimensions: ReadonlyMap<string, number>,
  out: number[],
): void {
  const value = (name: string): number => {
    const found = dimensions.get(name);
    if (found === undefined) throw new Error(`Dimension "${name}" has no value`);
    return found;
  };

  switch (constraint.kind) {
    case 'coincident': {
      const a = at(x, layout, pointIndex(sketch, constraint.a, 'Coincident'));
      const b = at(x, layout, pointIndex(sketch, constraint.b, 'Coincident'));
      out.push(a.u - b.u, a.v - b.v);
      return;
    }
    case 'concentric': {
      const a = at(x, layout, circleOf(sketch, constraint.a, 'Concentric').centre);
      const b = at(x, layout, circleOf(sketch, constraint.b, 'Concentric').centre);
      out.push(a.u - b.u, a.v - b.v);
      return;
    }
    case 'horizontal':
      out.push(direction(x, layout, sketch, constraint.line).v);
      return;
    case 'vertical':
      out.push(direction(x, layout, sketch, constraint.line).u);
      return;
    case 'parallel': {
      const d1 = direction(x, layout, sketch, constraint.a);
      const d2 = direction(x, layout, sketch, constraint.b);
      const scale = Math.max(norm(d1) * norm(d2), EPSILON);
      out.push((d1.u * d2.v - d1.v * d2.u) / scale);
      return;
    }
    case 'perpendicular': {
      const d1 = direction(x, layout, sketch, constraint.a);
      const d2 = direction(x, layout, sketch, constraint.b);
      const scale = Math.max(norm(d1) * norm(d2), EPSILON);
      out.push((d1.u * d2.u + d1.v * d2.v) / scale);
      return;
    }
    case 'equal': {
      const d1 = direction(x, layout, sketch, constraint.a);
      const d2 = direction(x, layout, sketch, constraint.b);
      out.push(norm(d1) - norm(d2));
      return;
    }
    case 'pointOnLine': {
      const line = lineOf(sketch, constraint.line, 'Point on line');
      const a = at(x, layout, line.a);
      const b = at(x, layout, line.b);
      const p = at(x, layout, pointIndex(sketch, constraint.point, 'Point on line'));
      const d = { u: b.u - a.u, v: b.v - a.v };
      const scale = Math.max(norm(d), EPSILON);
      out.push((d.u * (p.v - a.v) - d.v * (p.u - a.u)) / scale);
      return;
    }
    case 'midpoint': {
      const line = lineOf(sketch, constraint.line, 'Midpoint');
      const a = at(x, layout, line.a);
      const b = at(x, layout, line.b);
      const p = at(x, layout, pointIndex(sketch, constraint.point, 'Midpoint'));
      out.push(p.u - (a.u + b.u) / 2, p.v - (a.v + b.v) / 2);
      return;
    }
    case 'lockU':
      out.push(at(x, layout, pointIndex(sketch, constraint.point, 'Lock U')).u - value(constraint.dimension));
      return;
    case 'lockV':
      out.push(at(x, layout, pointIndex(sketch, constraint.point, 'Lock V')).v - value(constraint.dimension));
      return;
    case 'distance': {
      const a = at(x, layout, pointIndex(sketch, constraint.a, 'Distance'));
      const b = at(x, layout, pointIndex(sketch, constraint.b, 'Distance'));
      out.push(Math.hypot(b.u - a.u, b.v - a.v) - value(constraint.dimension));
      return;
    }
    case 'horizontalDistance': {
      const a = at(x, layout, pointIndex(sketch, constraint.a, 'Horizontal distance'));
      const b = at(x, layout, pointIndex(sketch, constraint.b, 'Horizontal distance'));
      out.push(b.u - a.u - value(constraint.dimension));
      return;
    }
    case 'verticalDistance': {
      const a = at(x, layout, pointIndex(sketch, constraint.a, 'Vertical distance'));
      const b = at(x, layout, pointIndex(sketch, constraint.b, 'Vertical distance'));
      out.push(b.v - a.v - value(constraint.dimension));
      return;
    }
    case 'radius': {
      circleOf(sketch, constraint.circle, 'Radius');
      out.push(x[layout.radiusAt.get(constraint.circle)!]! - value(constraint.dimension));
      return;
    }
    case 'angle': {
      const d1 = direction(x, layout, sketch, constraint.a);
      const d2 = direction(x, layout, sketch, constraint.b);
      const between = Math.atan2(d1.u * d2.v - d1.v * d2.u, d1.u * d2.u + d1.v * d2.v);
      out.push(between - (value(constraint.dimension) * Math.PI) / 180);
      return;
    }
  }
}

function evaluate(
  sketch: Sketch,
  layout: Layout,
  x: readonly number[],
  dimensions: ReadonlyMap<string, number>,
): number[] {
  const out: number[] = [];
  for (const constraint of sketch.constraints) {
    residualsOf(constraint, sketch, layout, x, dimensions, out);
  }
  return out;
}

/** Central differences: two evaluations per unknown, and no derivatives by hand. */
function jacobian(
  sketch: Sketch,
  layout: Layout,
  x: number[],
  dimensions: ReadonlyMap<string, number>,
  rows: number,
): number[][] {
  const J: number[][] = Array.from({ length: rows }, () => new Array<number>(layout.size).fill(0));

  for (let column = 0; column < layout.size; column++) {
    const step = 1e-7 * Math.max(1, Math.abs(x[column]!));
    const original = x[column]!;

    x[column] = original + step;
    const forward = evaluate(sketch, layout, x, dimensions);
    x[column] = original - step;
    const backward = evaluate(sketch, layout, x, dimensions);
    x[column] = original;

    for (let row = 0; row < rows; row++) {
      J[row]![column] = (forward[row]! - backward[row]!) / (2 * step);
    }
  }

  return J;
}

/** Gaussian elimination with partial pivoting; the system is small and dense. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, index) => [...row, b[index]!]);

  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(M[row]![column]!) > Math.abs(M[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(M[pivot]![column]!) < 1e-14) return null;
    [M[column], M[pivot]] = [M[pivot]!, M[column]!];

    for (let row = column + 1; row < n; row++) {
      const factor = M[row]![column]! / M[column]![column]!;
      if (factor === 0) continue;
      for (let k = column; k <= n; k++) M[row]![k] = M[row]![k]! - factor * M[column]![k]!;
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row]![n]!;
    for (let k = row + 1; k < n; k++) sum -= M[row]![k]! * x[k]!;
    x[row] = sum / M[row]![row]!;
  }
  return x;
}

/** Row-reduces a copy of the Jacobian to count independent constraints. */
function rankOf(J: readonly number[][], columns: number): number {
  const M = J.map((row) => [...row]);
  let rank = 0;

  for (let column = 0; column < columns && rank < M.length; column++) {
    let pivot = -1;
    let best = 1e-8;
    for (let row = rank; row < M.length; row++) {
      if (Math.abs(M[row]![column]!) > best) {
        best = Math.abs(M[row]![column]!);
        pivot = row;
      }
    }
    if (pivot < 0) continue;

    [M[rank], M[pivot]] = [M[pivot]!, M[rank]!];
    for (let row = 0; row < M.length; row++) {
      if (row === rank) continue;
      const factor = M[row]![column]! / M[rank]![column]!;
      if (factor === 0) continue;
      for (let k = column; k < columns; k++) M[row]![k] = M[row]![k]! - factor * M[rank]![k]!;
    }
    rank += 1;
  }

  return rank;
}

export function solveSketch(
  sketch: Sketch,
  dimensions: ReadonlyMap<string, number>,
  options: SolveOptions = {},
): SolveResult {
  const tolerance = options.tolerance ?? 1e-9;
  const maxIterations = options.maxIterations ?? 200;

  const layout = layoutOf(sketch);
  const x = pack(sketch, layout);

  const unpack = (rows: number, iterations: number, worst: number, solved: boolean): SolveResult => {
    const J = rows === 0 ? [] : jacobian(sketch, layout, x, dimensions, rows);
    const rank = rows === 0 ? 0 : rankOf(J, layout.size);
    return {
      points: sketch.points.map((_, index) => ({
        u: x[layout.pointAt[index]!]!,
        v: x[layout.pointAt[index]! + 1]!,
      })),
      radii: sketch.entities.map((entity, index) =>
        entity.kind === 'circle' ? x[layout.radiusAt.get(index)!]! : 0,
      ),
      solved,
      worst,
      iterations,
      freedom: Math.max(layout.size - rank, 0),
      redundant: Math.max(rows - rank, 0),
    };
  };

  let residual = evaluate(sketch, layout, x, dimensions);
  const rows = residual.length;
  if (rows === 0) return unpack(0, 0, 0, true);

  const worstOf = (r: readonly number[]): number => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const costOf = (r: readonly number[]): number => r.reduce((sum, v) => sum + v * v, 0);

  let cost = costOf(residual);
  let lambda = 1e-3;
  let iterations = 0;

  while (iterations < maxIterations && worstOf(residual) > tolerance) {
    iterations += 1;

    const J = jacobian(sketch, layout, x, dimensions, rows);

    // Normal equations: (JtJ + lambda * diag(JtJ)) step = -Jt r.
    const JtJ: number[][] = Array.from({ length: layout.size }, () =>
      new Array<number>(layout.size).fill(0),
    );
    const Jtr = new Array<number>(layout.size).fill(0);
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < layout.size; i++) {
        const value = J[row]![i]!;
        if (value === 0) continue;
        Jtr[i] = Jtr[i]! + value * residual[row]!;
        for (let k = i; k < layout.size; k++) {
          JtJ[i]![k] = JtJ[i]![k]! + value * J[row]![k]!;
        }
      }
    }
    for (let i = 0; i < layout.size; i++) {
      for (let k = 0; k < i; k++) JtJ[i]![k] = JtJ[k]![i]!;
    }

    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
      const A = JtJ.map((row, i) => {
        const copy = [...row];
        // Damping scaled by the diagonal keeps well- and badly-scaled unknowns
        // moving at comparable rates.
        copy[i] = copy[i]! + lambda * Math.max(JtJ[i]![i]!, 1e-12);
        return copy;
      });

      const step = solveLinear(A, Jtr.map((value) => -value));
      if (step === null) {
        lambda *= 10;
        continue;
      }

      const trial = x.map((value, index) => value + step[index]!);
      const trialResidual = evaluate(sketch, layout, trial, dimensions);
      const trialCost = costOf(trialResidual);

      if (trialCost < cost) {
        for (let i = 0; i < layout.size; i++) x[i] = trial[i]!;
        residual = trialResidual;
        cost = trialCost;
        lambda = Math.max(lambda / 3, 1e-12);
        accepted = true;
      } else {
        lambda *= 3;
      }
    }

    if (!accepted) break;
  }

  const worst = worstOf(residual);
  return unpack(rows, iterations, worst, worst <= Math.max(tolerance, 1e-7));
}
