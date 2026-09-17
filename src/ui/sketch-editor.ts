import type { Graph } from '../core/graph.js';
import type { NodeId, PlaneValue, Value, Vec3 } from '../core/types.js';
import { pointOnPlane } from '../geometry/plane.js';
import type { Constraint, Sketch } from '../sketch/model.js';
import { decodeSketch, dimensionsOf, encodeSketch } from '../sketch/model.js';
import type { SolveResult } from '../sketch/solver.js';
import { solveSketch } from '../sketch/solver.js';
import { dimensionPort } from '../nodes/constrained.js';

export interface SketchEditorCallbacks {
  onBeforeChange(): void;
  onChanged(): void;
  onExit(): void;
}

type Selection = { kind: 'point' | 'entity'; index: number };

interface Tool {
  id: string;
  label: string;
  /** Null when the current selection suits it, otherwise why it does not. */
  check: (picked: Selection[], sketch: Sketch) => string | null;
  apply: (picked: Selection[], sketch: Sketch) => Constraint[];
}

const CIRCLE_SEGMENTS = 48;
/** How far a click may land from what it means to hit, in pixels. */
const PICK_SLACK = 10;

function isLine(sketch: Sketch, index: number): boolean {
  return sketch.entities[index]?.kind === 'line';
}

function isCircle(sketch: Sketch, index: number): boolean {
  return sketch.entities[index]?.kind === 'circle';
}

function lines(picked: Selection[]): number[] {
  return picked.filter((entry) => entry.kind === 'entity').map((entry) => entry.index);
}

function points(picked: Selection[]): number[] {
  return picked.filter((entry) => entry.kind === 'point').map((entry) => entry.index);
}

function needs(
  test: (picked: Selection[], sketch: Sketch) => boolean,
  message: string,
): (picked: Selection[], sketch: Sketch) => string | null {
  return (picked, sketch) => (test(picked, sketch) ? null : message);
}

const RELATIONS: Tool[] = [
  {
    id: 'horizontal',
    label: 'Horizontal',
    check: needs(
      (p, s) => lines(p).length === 1 && points(p).length === 0 && isLine(s, lines(p)[0]!),
      'Pick one line',
    ),
    apply: (p) => [{ kind: 'horizontal', line: lines(p)[0]! }],
  },
  {
    id: 'vertical',
    label: 'Vertical',
    check: needs(
      (p, s) => lines(p).length === 1 && points(p).length === 0 && isLine(s, lines(p)[0]!),
      'Pick one line',
    ),
    apply: (p) => [{ kind: 'vertical', line: lines(p)[0]! }],
  },
  {
    id: 'parallel',
    label: 'Parallel',
    check: needs(
      (p, s) => lines(p).length === 2 && lines(p).every((i) => isLine(s, i)),
      'Pick two lines',
    ),
    apply: (p) => [{ kind: 'parallel', a: lines(p)[0]!, b: lines(p)[1]! }],
  },
  {
    id: 'perpendicular',
    label: 'Perpendicular',
    check: needs(
      (p, s) => lines(p).length === 2 && lines(p).every((i) => isLine(s, i)),
      'Pick two lines',
    ),
    apply: (p) => [{ kind: 'perpendicular', a: lines(p)[0]!, b: lines(p)[1]! }],
  },
  {
    id: 'equal',
    label: 'Equal',
    check: needs(
      (p, s) => lines(p).length === 2 && lines(p).every((i) => isLine(s, i)),
      'Pick two lines',
    ),
    apply: (p) => [{ kind: 'equal', a: lines(p)[0]!, b: lines(p)[1]! }],
  },
  {
    id: 'coincident',
    label: 'Coincident',
    check: needs((p) => points(p).length === 2 && lines(p).length === 0, 'Pick two points'),
    apply: (p) => [{ kind: 'coincident', a: points(p)[0]!, b: points(p)[1]! }],
  },
  {
    id: 'concentric',
    label: 'Concentric',
    check: needs(
      (p, s) => lines(p).length === 2 && lines(p).every((i) => isCircle(s, i)),
      'Pick two circles',
    ),
    apply: (p) => [{ kind: 'concentric', a: lines(p)[0]!, b: lines(p)[1]! }],
  },
  {
    id: 'pointOnLine',
    label: 'On line',
    check: needs(
      (p, s) => points(p).length === 1 && lines(p).length === 1 && isLine(s, lines(p)[0]!),
      'Pick a point and a line',
    ),
    apply: (p) => [{ kind: 'pointOnLine', point: points(p)[0]!, line: lines(p)[0]! }],
  },
  {
    id: 'midpoint',
    label: 'Midpoint',
    check: needs(
      (p, s) => points(p).length === 1 && lines(p).length === 1 && isLine(s, lines(p)[0]!),
      'Pick a point and a line',
    ),
    apply: (p) => [{ kind: 'midpoint', point: points(p)[0]!, line: lines(p)[0]! }],
  },
];

/**
 * Editing a sketch that already exists: pick its parts, add relations, and place
 * dimensions.
 *
 * The solver runs here rather than in the worker. The editor needs the solved
 * points with their identities to draw and hit-test — a returned mesh cannot say
 * which vertex was point three — and having them makes the freedom readout and
 * the overlay immediate. The worker solves the same sketch again from the same
 * inputs to build the actual face; the solver is pure, so the two agree.
 */
export class SketchEditor {
  private readonly panel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly listEl: HTMLElement;

  private nodeId: NodeId | null = null;
  private plane: PlaneValue | null = null;
  private sketch: Sketch | null = null;
  private dimensions = new Map<string, number>();
  private picked: Selection[] = [];
  private result: SolveResult | null = null;

  constructor(
    container: HTMLElement,
    private readonly graph: Graph,
    private readonly viewport: import('../viewport.js').Viewport,
    private readonly callbacks: SketchEditorCallbacks,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'sketch-panel sketch-editor';
    this.panel.hidden = true;
    container.append(this.panel);

    const title = document.createElement('div');
    title.className = 'sketch-title';
    title.textContent = 'Edit sketch';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'sketch-status';

    const tools = document.createElement('div');
    tools.className = 'sketch-tools';
    for (const tool of RELATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button';
      button.textContent = tool.label;
      button.addEventListener('click', () => this.applyRelation(tool));
      tools.append(button);
    }

    const dimension = document.createElement('button');
    dimension.type = 'button';
    dimension.className = 'tool-button tool-primary';
    dimension.textContent = 'Dimension';
    dimension.addEventListener('click', () => this.applyDimension());
    tools.append(dimension);

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'sketch-hint';

    this.listEl = document.createElement('div');
    this.listEl.className = 'sketch-list';

    const actions = document.createElement('div');
    actions.className = 'feature-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'tool-button tool-primary';
    done.textContent = 'Done';
    done.addEventListener('click', () => this.exit());
    actions.append(done);

    this.panel.append(title, this.statusEl, tools, this.hintEl, this.listEl, actions);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  get isActive(): boolean {
    return this.nodeId !== null;
  }

  /** Where the solver currently has each point, in the sketch plane's axes. */
  solvedPoints(): ReadonlyArray<{ u: number; v: number }> {
    return this.result?.points ?? [];
  }

  /** True when this node is one the editor can open. */
  static editable(graph: Graph, nodeId: NodeId | null): boolean {
    if (nodeId === null) return false;
    return graph.getNode(nodeId)?.type === 'sketch.constrained';
  }

  enter(nodeId: NodeId, plane: PlaneValue): void {
    const node = this.graph.requireNode(nodeId);
    this.sketch = decodeSketch(
      node.inputs.points ?? [],
      node.inputs.entities ?? [],
      node.inputs.constraints ?? [],
    );

    this.dimensions = new Map();
    for (const name of dimensionsOf(this.sketch)) {
      const value = this.graph.inputValue(nodeId, dimensionPort(name));
      this.dimensions.set(name, typeof value === 'number' ? value : 0);
    }

    this.nodeId = nodeId;
    this.plane = plane;
    this.picked = [];

    this.panel.hidden = false;
    this.viewport.setPickingEnabled(false);
    this.viewport.setDimmed(true);
    this.viewport.alignToPlane(plane);
    this.viewport.canvas.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('keydown', this.onKeyDown);

    this.resolve();
  }

  exit(): void {
    if (this.nodeId === null) return;

    this.viewport.canvas.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('keydown', this.onKeyDown);

    this.nodeId = null;
    this.plane = null;
    this.sketch = null;
    this.picked = [];
    this.result = null;

    this.panel.hidden = true;
    this.viewport.clearSketchOverlay();
    this.viewport.setDimmed(false);
    this.viewport.setPickingEnabled(true);
    this.viewport.releasePlaneAlignment();
    this.callbacks.onExit();
  }

  // ------------------------------------------------------------- solving

  private resolve(): void {
    if (this.sketch === null) return;
    this.result = solveSketch(this.sketch, this.dimensions);
    this.render();
  }

  /** Writes the working sketch back, solved points and all. */
  private commit(): void {
    const sketch = this.sketch;
    const nodeId = this.nodeId;
    if (sketch === null || nodeId === null || this.result === null) return;

    // Store where the solver put things, so the drawing and the rules agree.
    if (this.result.solved) {
      sketch.points = this.result.points.map((point) => ({ ...point }));
      for (const [index, entity] of sketch.entities.entries()) {
        if (entity.kind === 'circle') entity.radius = this.result.radii[index]!;
      }
    }

    const encoded = encodeSketch(sketch);
    const dims: Array<string | number> = [];
    for (const [name, value] of this.dimensions) dims.push(name, value);

    this.graph.setInput(nodeId, 'points', encoded.points);
    this.graph.setInput(nodeId, 'entities', encoded.entities as Value[]);
    this.graph.setInput(nodeId, 'constraints', encoded.constraints as Value[]);
    this.graph.setInput(nodeId, 'dims', dims as Value[]);
    for (const [name, value] of this.dimensions) {
      this.graph.setInput(nodeId, dimensionPort(name), value);
    }

    this.callbacks.onChanged();
  }

  // --------------------------------------------------------------- tools

  private applyRelation(tool: Tool): void {
    const sketch = this.sketch;
    if (sketch === null) return;

    const problem = tool.check(this.picked, sketch);
    if (problem !== null) {
      this.hintEl.textContent = `${tool.label}: ${problem}.`;
      return;
    }

    const added = tool.apply(this.picked, sketch);
    this.tryAdding(added, tool.label);
  }

  private applyDimension(): void {
    const sketch = this.sketch;
    if (sketch === null || this.result === null) return;

    const chosenLines = lines(this.picked);
    const chosenPoints = points(this.picked);
    const solved = this.result.points;

    const unique = (stem: string): string => {
      let n = 1;
      while (this.dimensions.has(`${stem}${n}`)) n += 1;
      return `${stem}${n}`;
    };

    let constraint: Constraint | null = null;
    let value = 0;

    if (chosenLines.length === 1 && chosenPoints.length === 0) {
      const entity = sketch.entities[chosenLines[0]!]!;
      if (entity.kind === 'circle') {
        const name = unique('radius');
        constraint = { kind: 'radius', circle: chosenLines[0]!, dimension: name };
        value = this.result.radii[chosenLines[0]!]!;
      } else {
        const name = unique('length');
        constraint = { kind: 'distance', a: entity.a, b: entity.b, dimension: name };
        const from = solved[entity.a]!;
        const to = solved[entity.b]!;
        value = Math.hypot(to.u - from.u, to.v - from.v);
      }
    } else if (chosenPoints.length === 2 && chosenLines.length === 0) {
      const name = unique('distance');
      constraint = { kind: 'distance', a: chosenPoints[0]!, b: chosenPoints[1]!, dimension: name };
      const from = solved[chosenPoints[0]!]!;
      const to = solved[chosenPoints[1]!]!;
      value = Math.hypot(to.u - from.u, to.v - from.v);
    } else if (chosenLines.length === 2 && chosenLines.every((i) => isLine(sketch, i))) {
      const name = unique('angle');
      constraint = { kind: 'angle', a: chosenLines[0]!, b: chosenLines[1]!, dimension: name };
      value = this.angleBetween(chosenLines[0]!, chosenLines[1]!);
    }

    if (constraint === null) {
      this.hintEl.textContent =
        'Dimension: pick a line, a circle, two points, or two lines for an angle.';
      return;
    }

    const name = (constraint as { dimension: string }).dimension;
    this.dimensions.set(name, value);
    if (!this.tryAdding([constraint], 'Dimension')) this.dimensions.delete(name);
  }

  private angleBetween(a: number, b: number): number {
    const sketch = this.sketch!;
    const solved = this.result!.points;
    const dir = (index: number): { u: number; v: number } => {
      const line = sketch.entities[index]!;
      if (line.kind !== 'line') return { u: 1, v: 0 };
      const from = solved[line.a]!;
      const to = solved[line.b]!;
      return { u: to.u - from.u, v: to.v - from.v };
    };
    const d1 = dir(a);
    const d2 = dir(b);
    return (Math.atan2(d1.u * d2.v - d1.v * d2.u, d1.u * d2.u + d1.v * d2.v) * 180) / Math.PI;
  }

  /**
   * Adds constraints only if the sketch still solves with them. A rule that
   * contradicts what is already there is refused and rolled back, so the sketch
   * is never left in a state the solver cannot make sense of.
   */
  private tryAdding(added: Constraint[], label: string): boolean {
    const sketch = this.sketch;
    if (sketch === null) return false;

    const before = [...sketch.constraints];
    sketch.constraints = [...before, ...added];

    const attempt = solveSketch(sketch, this.dimensions);
    if (!attempt.solved) {
      sketch.constraints = before;
      this.hintEl.textContent = `${label} contradicts the rules already here.`;
      this.render();
      return false;
    }

    this.callbacks.onBeforeChange();
    this.result = attempt;
    this.picked = [];
    this.hintEl.textContent =
      attempt.redundant > 0 ? `${label} added, but it repeats a rule already here.` : `${label} added.`;
    this.commit();
    this.render();
    return true;
  }

  private removeConstraint(index: number): void {
    const sketch = this.sketch;
    if (sketch === null) return;

    const [removed] = sketch.constraints.splice(index, 1);
    if (removed !== undefined && 'dimension' in removed) {
      const stillUsed = sketch.constraints.some(
        (other) => 'dimension' in other && other.dimension === removed.dimension,
      );
      if (!stillUsed) this.dimensions.delete(removed.dimension);
    }

    this.callbacks.onBeforeChange();
    this.resolve();
    this.commit();
  }

  private setDimension(name: string, value: number): void {
    this.dimensions.set(name, value);
    this.callbacks.onBeforeChange();
    this.resolve();
    this.commit();
  }

  // ------------------------------------------------------------- picking

  private onPointerDown(event: PointerEvent): void {
    const sketch = this.sketch;
    const plane = this.plane;
    if (sketch === null || plane === null || this.result === null) return;
    if (event.button !== 0) return;

    const at = this.viewport.planePoint(event.clientX, event.clientY, plane);
    if (at === null) return;
    const slack = this.viewport.pickTolerance(plane, PICK_SLACK);

    const hit = this.nearest(at, slack);
    if (hit === null) {
      this.picked = [];
      this.render();
      return;
    }

    const already = this.picked.findIndex(
      (entry) => entry.kind === hit.kind && entry.index === hit.index,
    );
    if (already >= 0) this.picked.splice(already, 1);
    else this.picked.push(hit);

    this.render();
  }

  /** Points win over entities, because a point is the harder thing to hit. */
  private nearest(at: { u: number; v: number }, slack: number): Selection | null {
    const sketch = this.sketch!;
    const solved = this.result!;

    let best: Selection | null = null;
    let bestDistance = slack;

    for (const [index, point] of solved.points.entries()) {
      const distance = Math.hypot(point.u - at.u, point.v - at.v);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'point', index };
      }
    }
    if (best !== null) return best;

    bestDistance = slack;
    for (const [index, entity] of sketch.entities.entries()) {
      const distance =
        entity.kind === 'line'
          ? distanceToSegment(at, solved.points[entity.a]!, solved.points[entity.b]!)
          : Math.abs(
              Math.hypot(
                solved.points[entity.centre]!.u - at.u,
                solved.points[entity.centre]!.v - at.v,
              ) - solved.radii[index]!,
            );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { kind: 'entity', index };
      }
    }
    return best;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.picked.length > 0) {
        this.picked = [];
        this.render();
      } else {
        this.exit();
      }
    }
  }

  // ----------------------------------------------------------- rendering

  private render(): void {
    const sketch = this.sketch;
    const plane = this.plane;
    const solved = this.result;
    if (sketch === null || plane === null || solved === null) return;

    const isPicked = (kind: 'point' | 'entity', index: number): boolean =>
      this.picked.some((entry) => entry.kind === kind && entry.index === index);

    const segments: Array<{ points: Vec3[]; selected: boolean }> = [];
    for (const [index, entity] of sketch.entities.entries()) {
      const selected = isPicked('entity', index);
      if (entity.kind === 'line') {
        const a = solved.points[entity.a]!;
        const b = solved.points[entity.b]!;
        segments.push({
          points: [pointOnPlane(plane, a.u, a.v), pointOnPlane(plane, b.u, b.v)],
          selected,
        });
        continue;
      }

      const centre = solved.points[entity.centre]!;
      const radius = solved.radii[index]!;
      const ring: Vec3[] = [];
      for (let step = 0; step <= CIRCLE_SEGMENTS; step++) {
        const angle = (step / CIRCLE_SEGMENTS) * Math.PI * 2;
        ring.push(
          pointOnPlane(plane, centre.u + radius * Math.cos(angle), centre.v + radius * Math.sin(angle)),
        );
      }
      segments.push({ points: ring, selected });
    }

    const vertices = solved.points.map((point, index) => ({
      at: pointOnPlane(plane, point.u, point.v),
      selected: isPicked('point', index),
    }));

    this.viewport.setSketchOverlay(segments, vertices);
    this.renderPanel(solved);
  }

  private renderPanel(solved: SolveResult): void {
    const sketch = this.sketch!;

    const parts: string[] = [];
    if (!solved.solved) parts.push('These rules cannot all hold');
    else if (solved.freedom === 0) parts.push('Fully constrained');
    else parts.push(`${solved.freedom} degree${solved.freedom === 1 ? '' : 's'} of freedom`);
    if (solved.redundant > 0) parts.push(`${solved.redundant} redundant`);
    this.statusEl.textContent = parts.join(' · ');
    this.statusEl.dataset.state = solved.solved
      ? solved.freedom === 0
        ? 'exact'
        : 'loose'
      : 'broken';

    this.listEl.replaceChildren();
    for (const [index, constraint] of sketch.constraints.entries()) {
      const row = document.createElement('div');
      row.className = 'sketch-row';

      const label = document.createElement('span');
      label.className = 'sketch-row-label';
      label.textContent = describe(constraint);
      row.append(label);

      if ('dimension' in constraint) {
        const field = document.createElement('input');
        field.type = 'number';
        field.className = 'port-value';
        field.value = String(this.dimensions.get(constraint.dimension) ?? 0);
        field.addEventListener('change', () => {
          const next = Number(field.value);
          if (!Number.isNaN(next)) this.setDimension(constraint.dimension, next);
        });
        row.append(field);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'sketch-remove';
      remove.textContent = '×';
      remove.title = 'Remove this rule';
      remove.addEventListener('click', () => this.removeConstraint(index));
      row.append(remove);

      this.listEl.append(row);
    }
  }
}

function describe(constraint: Constraint): string {
  switch (constraint.kind) {
    case 'lockU':
      return `Lock U of P${constraint.point + 1}`;
    case 'lockV':
      return `Lock V of P${constraint.point + 1}`;
    case 'horizontal':
      return `Horizontal E${constraint.line + 1}`;
    case 'vertical':
      return `Vertical E${constraint.line + 1}`;
    case 'radius':
      return `Radius of E${constraint.circle + 1}`;
    case 'pointOnLine':
      return `P${constraint.point + 1} on E${constraint.line + 1}`;
    case 'midpoint':
      return `P${constraint.point + 1} midpoint of E${constraint.line + 1}`;
    case 'distance':
      return `Distance P${constraint.a + 1}–P${constraint.b + 1}`;
    case 'horizontalDistance':
      return `Width P${constraint.a + 1}–P${constraint.b + 1}`;
    case 'verticalDistance':
      return `Height P${constraint.a + 1}–P${constraint.b + 1}`;
    case 'angle':
      return `Angle E${constraint.a + 1}–E${constraint.b + 1}`;
    case 'coincident':
      return `P${constraint.a + 1} = P${constraint.b + 1}`;
    case 'concentric':
      return `Concentric E${constraint.a + 1}–E${constraint.b + 1}`;
    default:
      return `${constraint.kind[0]!.toUpperCase()}${constraint.kind.slice(1)} E${constraint.a + 1}–E${constraint.b + 1}`;
  }
}

function distanceToSegment(
  at: { u: number; v: number },
  a: { u: number; v: number },
  b: { u: number; v: number },
): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lengthSquared = du * du + dv * dv;
  if (lengthSquared < 1e-12) return Math.hypot(at.u - a.u, at.v - a.v);

  const t = Math.max(0, Math.min(1, ((at.u - a.u) * du + (at.v - a.v) * dv) / lengthSquared));
  return Math.hypot(at.u - (a.u + t * du), at.v - (a.v + t * dv));
}
