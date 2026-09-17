import type { Graph } from '../core/graph.js';
import type { NodeId, PlaneValue, Value, Vec3 } from '../core/types.js';
import { pointOnPlane } from '../geometry/plane.js';
import { dimensionPort } from '../nodes/constrained.js';
import type { Draft } from '../sketch/draw.js';
import { addCircle, addLine, addPoint, addRectangle, removeParts, uniqueName } from '../sketch/draw.js';
import type { Constraint, Point, Sketch } from '../sketch/model.js';
import { decodeSketch, dimensionsOf, encodeSketch } from '../sketch/model.js';
import type { SolveResult } from '../sketch/solver.js';
import { solveSketch } from '../sketch/solver.js';
import type { Viewport } from '../viewport.js';

export interface SketchSessionCallbacks {
  onBeforeChange(): void;
  onChanged(): void;
  onExit(): void;
}

type Selection = { kind: 'point' | 'entity'; index: number };
type ToolId = 'select' | 'line' | 'rectangle' | 'circle' | 'point';

interface DrawTool {
  id: ToolId;
  label: string;
  hint: string;
}

interface Relation {
  id: string;
  label: string;
  /** Null when the current selection suits it, otherwise why it does not. */
  check: (picked: Selection[], sketch: Sketch) => string | null;
  apply: (picked: Selection[], sketch: Sketch) => Constraint[];
}

const DRAW_TOOLS: DrawTool[] = [
  { id: 'select', label: 'Select', hint: 'Click what you want to constrain or dimension.' },
  {
    id: 'line',
    label: 'Line',
    hint: 'Click point after point. Enter or Escape ends the chain; clicking a point already there joins to it.',
  },
  { id: 'rectangle', label: 'Rectangle', hint: 'Click one corner, then the opposite corner.' },
  { id: 'circle', label: 'Circle', hint: 'Click the centre, then a point on the circle.' },
  { id: 'point', label: 'Point', hint: 'Click to place a point to constrain things against.' },
];

const CIRCLE_SEGMENTS = 48;
/** How far a click may land from what it means to hit, in pixels. */
const PICK_SLACK = 10;
/** Drawn positions land on this grid, in millimetres, so straight reads straight. */
const GRID = 1;

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

const RELATIONS: Relation[] = [
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
 * One sketching session: draw into a sketch, constrain it, dimension it, and
 * leave when you are done. Creating and editing are the same thing here,
 * because a sketch you just started and one you opened again differ only in how
 * much is already in them.
 *
 * Everything drawn is written to the node as it happens, so the model follows
 * along and leaving is never what commits the work.
 *
 * The solver runs here rather than in the worker. The session needs the solved
 * points with their identities to draw and hit-test — a returned mesh cannot say
 * which vertex was point three — and having them makes the freedom readout and
 * the overlay immediate. The worker solves the same sketch again from the same
 * inputs to build the actual face; the solver is pure, so the two agree.
 */
export class SketchSession {
  private readonly panel: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();

  private nodeId: NodeId | null = null;
  private plane: PlaneValue | null = null;
  private draft: Draft | null = null;
  private picked: Selection[] = [];
  private result: SolveResult | null = null;

  private tool: ToolId = 'select';
  /** Points clicked so far for the tool in hand, by index into the sketch. */
  private chain: number[] = [];
  /** Where the pointer is, snapped, while a tool is part way through. */
  private cursor: Point | null = null;

  constructor(
    container: HTMLElement,
    private readonly graph: Graph,
    private readonly viewport: Viewport,
    private readonly callbacks: SketchSessionCallbacks,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'sketch-panel';
    this.panel.hidden = true;
    container.append(this.panel);

    const heading = document.createElement('div');
    heading.className = 'sketch-heading';

    const title = document.createElement('div');
    title.className = 'sketch-title';
    title.textContent = 'Sketch';

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'sketch-status';
    heading.append(title, this.statusEl);

    const draw = this.group('Draw');
    for (const tool of DRAW_TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button';
      button.textContent = tool.label;
      button.addEventListener('click', () => this.setTool(tool.id));
      this.toolButtons.set(tool.id, button);
      draw.row.append(button);
    }

    const relations = this.group('Constrain');
    for (const relation of RELATIONS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button';
      button.textContent = relation.label;
      button.addEventListener('click', () => this.applyRelation(relation));
      relations.row.append(button);
    }

    const dimension = document.createElement('button');
    dimension.type = 'button';
    dimension.className = 'tool-button tool-primary';
    dimension.textContent = 'Dimension';
    dimension.addEventListener('click', () => this.applyDimension());

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tool-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => this.deletePicked());
    relations.row.append(dimension, remove);

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'sketch-hint';

    this.listEl = document.createElement('div');
    this.listEl.className = 'sketch-list';

    const actions = document.createElement('div');
    actions.className = 'feature-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'tool-button tool-primary';
    done.textContent = 'Finish';
    done.addEventListener('click', () => this.exit());
    actions.append(done);

    this.panel.append(heading, draw.el, relations.el, this.hintEl, this.listEl, actions);

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  private group(label: string): { el: HTMLElement; row: HTMLElement } {
    const el = document.createElement('div');
    el.className = 'sketch-group';

    const caption = document.createElement('div');
    caption.className = 'sketch-group-label';
    caption.textContent = label;

    const row = document.createElement('div');
    row.className = 'sketch-tools';

    el.append(caption, row);
    return { el, row };
  }

  get isActive(): boolean {
    return this.nodeId !== null;
  }

  /** Where the solver currently has each point, in the sketch plane's axes. */
  solvedPoints(): ReadonlyArray<Point> {
    return this.result?.points ?? [];
  }

  /** True when this node is one the session can open. */
  static editable(graph: Graph, nodeId: NodeId | null): boolean {
    if (nodeId === null) return false;
    return graph.getNode(nodeId)?.type === 'sketch.constrained';
  }

  enter(nodeId: NodeId, plane: PlaneValue): void {
    const node = this.graph.requireNode(nodeId);
    const sketch = decodeSketch(
      node.inputs.points ?? [],
      node.inputs.entities ?? [],
      node.inputs.constraints ?? [],
    );

    const dimensions = new Map<string, number>();
    for (const name of dimensionsOf(sketch)) {
      const value = this.graph.inputValue(nodeId, dimensionPort(name));
      dimensions.set(name, typeof value === 'number' ? value : 0);
    }

    this.draft = { sketch, dimensions };
    this.nodeId = nodeId;
    this.plane = plane;
    this.picked = [];
    this.chain = [];
    this.cursor = null;

    this.panel.hidden = false;
    this.viewport.setPickingEnabled(false);
    this.viewport.setDimmed(true);
    this.viewport.alignToPlane(plane);
    this.viewport.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.viewport.canvas.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('keydown', this.onKeyDown);

    // A sketch with nothing in it was just created, so start drawing; one with
    // something in it was opened to be worked on, so start by picking.
    this.setTool(sketch.entities.length === 0 ? 'line' : 'select');
    this.resolve();
  }

  exit(): void {
    const nodeId = this.nodeId;
    if (nodeId === null) return;

    // A sketch nobody drew in is not worth keeping: left behind it would sit in
    // the graph reporting that it has nothing in it.
    if (this.draft !== null && this.draft.sketch.points.length === 0) {
      this.callbacks.onBeforeChange();
      this.graph.removeNode(nodeId);
      this.callbacks.onChanged();
    }

    this.viewport.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.viewport.canvas.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('keydown', this.onKeyDown);

    this.nodeId = null;
    this.plane = null;
    this.draft = null;
    this.picked = [];
    this.chain = [];
    this.result = null;

    this.panel.hidden = true;
    this.viewport.clearSketchOverlay();
    this.viewport.clearSketchPreview();
    this.viewport.setDimmed(false);
    this.viewport.setPickingEnabled(true);
    this.viewport.releasePlaneAlignment();
    this.callbacks.onExit();
  }

  /**
   * Picks the node's state back up after something else changed it, such as an
   * undo. The session holds a working copy, which would otherwise carry on from
   * a state the document no longer has.
   */
  refresh(): void {
    const nodeId = this.nodeId;
    const plane = this.plane;
    if (nodeId === null || plane === null) return;

    if (this.graph.getNode(nodeId) === null) {
      this.exit();
      return;
    }

    const tool = this.tool;
    this.enter(nodeId, plane);
    this.setTool(tool);
  }

  // ------------------------------------------------------------- solving

  private resolve(): void {
    if (this.draft === null) return;
    this.result = solveSketch(this.draft.sketch, this.draft.dimensions);
    this.render();
  }

  /**
   * Brings the drawing up to date with the solver before anything is added to
   * it. New points snap to the ones already there, and those have to be where
   * the solver put them rather than where they were first drawn.
   */
  private sync(): void {
    const draft = this.draft;
    if (draft === null || this.result === null || !this.result.solved) return;

    draft.sketch.points = this.result.points.map((point) => ({ ...point }));
    for (const [index, entity] of draft.sketch.entities.entries()) {
      if (entity.kind === 'circle') entity.radius = this.result.radii[index]!;
    }
  }

  /** Writes the working sketch back, solved points and all. */
  private commit(): void {
    const draft = this.draft;
    const nodeId = this.nodeId;
    if (draft === null || nodeId === null) return;

    this.sync();

    const encoded = encodeSketch(draft.sketch);
    const dims: Array<string | number> = [];
    for (const [name, value] of draft.dimensions) dims.push(name, value);

    this.graph.setInput(nodeId, 'points', encoded.points);
    this.graph.setInput(nodeId, 'entities', encoded.entities as Value[]);
    this.graph.setInput(nodeId, 'constraints', encoded.constraints as Value[]);
    this.graph.setInput(nodeId, 'dims', dims as Value[]);
    for (const [name, value] of draft.dimensions) {
      this.graph.setInput(nodeId, dimensionPort(name), value);
    }

    this.callbacks.onChanged();
  }

  // --------------------------------------------------------------- tools

  private setTool(tool: ToolId): void {
    this.tool = tool;
    this.chain = [];
    this.cursor = null;
    if (tool !== 'select') this.picked = [];

    for (const [id, button] of this.toolButtons) button.classList.toggle('is-active', id === tool);
    this.hintEl.textContent = DRAW_TOOLS.find((entry) => entry.id === tool)?.hint ?? '';
    this.render();
  }

  private applyRelation(relation: Relation): void {
    const draft = this.draft;
    if (draft === null) return;

    const problem = relation.check(this.picked, draft.sketch);
    if (problem !== null) {
      this.hintEl.textContent = `${relation.label}: ${problem}.`;
      return;
    }

    this.tryAdding(relation.apply(this.picked, draft.sketch), relation.label);
  }

  private applyDimension(): void {
    const draft = this.draft;
    if (draft === null || this.result === null) return;

    const sketch = draft.sketch;
    const chosenLines = lines(this.picked);
    const chosenPoints = points(this.picked);
    const solved = this.result.points;

    let constraint: Constraint | null = null;
    let value = 0;

    if (chosenLines.length === 1 && chosenPoints.length === 0) {
      const entity = sketch.entities[chosenLines[0]!]!;
      if (entity.kind === 'circle') {
        constraint = {
          kind: 'radius',
          circle: chosenLines[0]!,
          dimension: uniqueName(draft.dimensions, 'radius'),
        };
        value = this.result.radii[chosenLines[0]!]!;
      } else {
        constraint = {
          kind: 'distance',
          a: entity.a,
          b: entity.b,
          dimension: uniqueName(draft.dimensions, 'length'),
        };
        const from = solved[entity.a]!;
        const to = solved[entity.b]!;
        value = Math.hypot(to.u - from.u, to.v - from.v);
      }
    } else if (chosenPoints.length === 2 && chosenLines.length === 0) {
      constraint = {
        kind: 'distance',
        a: chosenPoints[0]!,
        b: chosenPoints[1]!,
        dimension: uniqueName(draft.dimensions, 'distance'),
      };
      const from = solved[chosenPoints[0]!]!;
      const to = solved[chosenPoints[1]!]!;
      value = Math.hypot(to.u - from.u, to.v - from.v);
    } else if (chosenLines.length === 2 && chosenLines.every((i) => isLine(sketch, i))) {
      constraint = {
        kind: 'angle',
        a: chosenLines[0]!,
        b: chosenLines[1]!,
        dimension: uniqueName(draft.dimensions, 'angle'),
      };
      value = this.angleBetween(chosenLines[0]!, chosenLines[1]!);
    }

    if (constraint === null) {
      this.hintEl.textContent =
        'Dimension: pick a line, a circle, two points, or two lines for an angle.';
      return;
    }

    const name = (constraint as { dimension: string }).dimension;
    draft.dimensions.set(name, value);
    if (!this.tryAdding([constraint], 'Dimension')) draft.dimensions.delete(name);
  }

  private angleBetween(a: number, b: number): number {
    const sketch = this.draft!.sketch;
    const solved = this.result!.points;
    const dir = (index: number): Point => {
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
    const draft = this.draft;
    if (draft === null) return false;

    const before = [...draft.sketch.constraints];
    draft.sketch.constraints = [...before, ...added];

    const attempt = solveSketch(draft.sketch, draft.dimensions);
    if (!attempt.solved) {
      draft.sketch.constraints = before;
      this.hintEl.textContent = `${label} contradicts the rules already here.`;
      this.render();
      return false;
    }

    this.callbacks.onBeforeChange();
    this.result = attempt;
    this.picked = [];
    this.hintEl.textContent =
      attempt.redundant > 0
        ? `${label} added, but it repeats a rule already here.`
        : `${label} added.`;
    this.commit();
    this.render();
    return true;
  }

  private deletePicked(): void {
    const draft = this.draft;
    if (draft === null) return;
    if (this.picked.length === 0) {
      this.hintEl.textContent = 'Delete: pick what you want gone first.';
      return;
    }

    const entities = lines(this.picked);
    const loose = new Set(points(this.picked));
    // The ends of a deleted edge go with it, unless something else still holds
    // them. removeParts keeps whatever is still needed.
    for (const index of entities) {
      const entity = draft.sketch.entities[index]!;
      if (entity.kind === 'circle') loose.add(entity.centre);
      else {
        loose.add(entity.a);
        loose.add(entity.b);
      }
    }

    this.callbacks.onBeforeChange();
    this.sync();
    removeParts(draft, entities, [...loose]);
    this.picked = [];
    this.chain = [];
    this.resolve();
    this.commit();
    this.hintEl.textContent = 'Deleted.';
  }

  private removeConstraint(index: number): void {
    const draft = this.draft;
    if (draft === null) return;

    const [removed] = draft.sketch.constraints.splice(index, 1);
    if (removed !== undefined && 'dimension' in removed) {
      const stillUsed = draft.sketch.constraints.some(
        (other) => 'dimension' in other && other.dimension === removed.dimension,
      );
      if (!stillUsed) draft.dimensions.delete(removed.dimension);
    }

    this.callbacks.onBeforeChange();
    this.resolve();
    this.commit();
  }

  private setDimension(name: string, value: number): void {
    const draft = this.draft;
    if (draft === null) return;

    draft.dimensions.set(name, value);
    this.callbacks.onBeforeChange();
    this.resolve();
    this.commit();
  }

  // ------------------------------------------------------------- drawing

  private snapped(clientX: number, clientY: number): Point | null {
    if (this.plane === null) return null;
    const raw = this.viewport.planePoint(clientX, clientY, this.plane);
    if (raw === null) return null;
    return { u: Math.round(raw.u / GRID) * GRID, v: Math.round(raw.v / GRID) * GRID };
  }

  private slack(): number {
    return this.plane === null ? GRID : this.viewport.pickTolerance(this.plane, PICK_SLACK);
  }

  /** One click of whichever drawing tool is in hand. */
  private draw(at: Point): void {
    const draft = this.draft;
    if (draft === null) return;

    this.callbacks.onBeforeChange();
    this.sync();
    const slack = this.slack();

    if (this.tool === 'point') {
      addPoint(draft, at, slack);
      this.after();
      return;
    }

    if (this.tool === 'line') {
      const index = addPoint(draft, at, slack);
      const previous = this.chain[this.chain.length - 1];
      if (previous !== undefined) addLine(draft, previous, index);

      // Back to where the chain started: that closes it, and there is nothing
      // more to add to it.
      if (index === this.chain[0] && this.chain.length > 1) this.chain = [];
      else this.chain.push(index);

      this.after();
      return;
    }

    const start = this.chain[0];
    if (start === undefined) {
      this.chain = [addPoint(draft, at, slack)];
      this.after();
      return;
    }

    const from = draft.sketch.points[start]!;
    if (this.tool === 'rectangle') {
      if (at.u === from.u || at.v === from.v) {
        this.hintEl.textContent = 'That would be a rectangle with no width or height.';
        return;
      }
      addRectangle(draft, from, at, slack);
    } else {
      const radius = Math.hypot(at.u - from.u, at.v - from.v);
      if (radius < GRID) {
        this.hintEl.textContent = 'Move further from the centre to set a radius.';
        return;
      }
      addCircle(draft, from, radius, slack);
    }

    this.chain = [];
    this.after();
  }

  private after(): void {
    this.resolve();
    this.commit();
  }

  // ------------------------------------------------------------- picking

  private onPointerMove(event: PointerEvent): void {
    if (this.tool === 'select') return;
    this.cursor = this.snapped(event.clientX, event.clientY);
    this.renderPreview();
  }

  private onPointerDown(event: PointerEvent): void {
    const draft = this.draft;
    if (draft === null || this.result === null || event.button !== 0) return;

    const at = this.snapped(event.clientX, event.clientY);
    if (at === null) return;
    event.preventDefault();

    if (this.tool !== 'select') {
      this.draw(at);
      return;
    }

    const hit = this.nearest(at, this.slack());
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
  private nearest(at: Point, slack: number): Selection | null {
    const sketch = this.draft!.sketch;
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
    if (event.key === 'Enter') {
      event.preventDefault();
      this.chain = [];
      this.renderPreview();
      return;
    }

    if (event.key !== 'Escape') return;
    event.preventDefault();

    // Escape backs out one step at a time: the chain in hand, then the tool,
    // then the picks, and only then the session itself.
    if (this.chain.length > 0) {
      this.chain = [];
      this.renderPreview();
      return;
    }
    if (this.tool !== 'select') {
      this.setTool('select');
      return;
    }
    if (this.picked.length > 0) {
      this.picked = [];
      this.render();
      return;
    }
    this.exit();
  }

  // ----------------------------------------------------------- rendering

  private render(): void {
    const draft = this.draft;
    const plane = this.plane;
    const solved = this.result;
    if (draft === null || plane === null || solved === null) return;

    const sketch = draft.sketch;
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
      segments.push({ points: ring(plane, centre, solved.radii[index]!), selected });
    }

    const vertices = solved.points.map((point, index) => ({
      at: pointOnPlane(plane, point.u, point.v),
      selected: isPicked('point', index),
    }));

    this.viewport.setSketchOverlay(segments, vertices);
    this.renderPreview();
    this.renderPanel(solved);
  }

  /** The rubber band: what the tool in hand would add if you clicked now. */
  private renderPreview(): void {
    const draft = this.draft;
    const plane = this.plane;
    const at = this.cursor;
    if (draft === null || plane === null) return;

    const start = this.chain[this.tool === 'line' ? this.chain.length - 1 : 0];
    if (at === null || start === undefined || this.tool === 'select' || this.tool === 'point') {
      this.viewport.clearSketchPreview();
      return;
    }

    const from = draft.sketch.points[start]!;
    if (this.tool === 'circle') {
      const radius = Math.hypot(at.u - from.u, at.v - from.v);
      this.viewport.setSketchPreview(ring(plane, from, radius), true);
      return;
    }

    const corners: Point[] =
      this.tool === 'rectangle'
        ? [
            { u: from.u, v: from.v },
            { u: at.u, v: from.v },
            { u: at.u, v: at.v },
            { u: from.u, v: at.v },
          ]
        : [from, at];
    this.viewport.setSketchPreview(
      corners.map((corner) => pointOnPlane(plane, corner.u, corner.v)),
      this.tool === 'rectangle',
    );
  }

  private renderPanel(solved: SolveResult): void {
    const draft = this.draft!;

    const parts: string[] = [];
    if (!solved.solved) parts.push('These rules cannot all hold');
    else if (draft.sketch.points.length === 0) parts.push('Empty');
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
    for (const [index, constraint] of draft.sketch.constraints.entries()) {
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
        field.value = String(draft.dimensions.get(constraint.dimension) ?? 0);
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

function ring(plane: PlaneValue, centre: Point, radius: number): Vec3[] {
  const out: Vec3[] = [];
  for (let step = 0; step <= CIRCLE_SEGMENTS; step++) {
    const angle = (step / CIRCLE_SEGMENTS) * Math.PI * 2;
    out.push(
      pointOnPlane(plane, centre.u + radius * Math.cos(angle), centre.v + radius * Math.sin(angle)),
    );
  }
  return out;
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

function distanceToSegment(at: Point, a: Point, b: Point): number {
  const du = b.u - a.u;
  const dv = b.v - a.v;
  const lengthSquared = du * du + dv * dv;
  if (lengthSquared < 1e-12) return Math.hypot(at.u - a.u, at.v - a.v);

  const t = Math.max(0, Math.min(1, ((at.u - a.u) * du + (at.v - a.v) * dv) / lengthSquared));
  return Math.hypot(at.u - (a.u + t * du), at.v - (a.v + t * dv));
}
