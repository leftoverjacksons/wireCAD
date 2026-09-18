import type { Graph } from '../core/graph.js';
import type { NodeId, PlaneValue, Value, Vec3 } from '../core/types.js';
import { pointOnPlane } from '../geometry/plane.js';
import { dimensionPort } from '../nodes/constrained.js';
import type { Annotation, Place, SpanKind } from '../sketch/annotate.js';
import {
  annotate,
  annotateOne,
  chooseSpan,
  decodePlaces,
  encodePlaces,
  formatLength,
  measureOf,
  placeOf,
  placeOfSpan,
} from '../sketch/annotate.js';
import type { Glyph } from '../sketch/glyphs.js';
import { glyphReach, glyphsFor } from '../sketch/glyphs.js';
import type { Draft } from '../sketch/draw.js';
import { addCircle, addLine, addPoint, addRectangle, removeParts, uniqueName } from '../sketch/draw.js';
import type { Constraint, Point, Sketch } from '../sketch/model.js';
import { decodeSketch, dimensionsOf, encodeSketch } from '../sketch/model.js';
import type { Pull, SolveResult } from '../sketch/solver.js';
import { solveSketch } from '../sketch/solver.js';
import type { Viewport } from '../viewport.js';

export interface SketchSessionCallbacks {
  onBeforeChange(): void;
  onChanged(): void;
  onExit(): void;
}

/**
 * Something the sketch is made of, picked out. A constraint is as pickable as a
 * point is: its glyph or its dimension is drawn on the sketch, so clicking that
 * and pressing Delete is how a rule is taken back.
 */
type Selection = { kind: 'point' | 'entity' | 'constraint'; index: number };
type ToolId = 'select' | 'line' | 'rectangle' | 'circle' | 'point' | 'dimension';

/** The name a dimension goes by while it is still being placed. */
const PENDING = '\u2026';

/**
 * A dimension picked out but not yet put anywhere. What it measures can still
 * change while it is in the air: a second line turns a length into an angle,
 * and where it is dropped decides whether a diagonal reads as its length or as
 * one of its two components.
 */
interface Placing {
  constraint: Constraint;
  /** Null until the cursor has said where it goes, which leaves it automatic. */
  place: Place | null;
  value: number;
  /** What the dimension will be called, before a number is put on the end. */
  stem: string;
  /** A kind chosen by hand, which stops the cursor from choosing one. */
  pinned: SpanKind | null;
}

/**
 * A press on the drawing that has not yet decided what it is. Held still it is
 * a pick; moved it is a drag, of either the geometry or a dimension.
 */
interface Grab {
  hit: Selection | null;
  /** The dimension under the press, if that is what was taken hold of. */
  dimension: { name: string; constraint: Constraint } | null;
  screen: { x: number; y: number };
  at: Point;
  moved: boolean;
  /** The points the drag is carrying, and where each started. */
  pulls: Array<{ point: number; from: Point }>;
  /** The field being dragged by its number, which must not take focus. */
  field: HTMLInputElement | null;
}

const SPAN_KINDS: Array<{ id: SpanKind; label: string }> = [
  { id: 'distance', label: 'Aligned' },
  { id: 'horizontalDistance', label: 'Horizontal' },
  { id: 'verticalDistance', label: 'Vertical' },
];

function isSpanKind(kind: Constraint['kind']): kind is SpanKind {
  return kind === 'distance' || kind === 'horizontalDistance' || kind === 'verticalDistance';
}

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
  {
    id: 'select',
    label: 'Select',
    hint: 'Click to pick, drag to move as far as the rules allow, Delete to remove. Dimensions and relation marks are pickable too.',
  },
  {
    id: 'line',
    label: 'Line',
    hint: 'Click point after point. Enter or Escape ends the chain; clicking a point already there joins to it.',
  },
  { id: 'rectangle', label: 'Rectangle', hint: 'Click one corner, then the opposite corner.' },
  { id: 'circle', label: 'Circle', hint: 'Click the centre, then a point on the circle.' },
  { id: 'point', label: 'Point', hint: 'Click to place a point to constrain things against.' },
  {
    id: 'dimension',
    label: 'Dimension',
    hint: 'Click a line, a circle, or two points, then move to place the dimension and click. Click a second line instead for an angle. Then type the number.',
  },
];

const CIRCLE_SEGMENTS = 48;
/** How far a click may land from what it means to hit, in pixels. */
const PICK_SLACK = 10;
/** Drawn positions land on this grid, in millimetres, so straight reads straight. */
const GRID = 1;
/** How far a press has to travel, in pixels, before it is a drag and not a pick. */
const DRAG_SLACK = 4;

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
  /** The numbers drawn on the sketch, one field per dimension. */
  private readonly labelLayer: HTMLElement;
  private readonly labels = new Map<string, HTMLInputElement>();
  /** The number of the dimension being placed, which has no field of its own yet. */
  private readonly previewLabel: HTMLElement;
  private annotations: Annotation[] = [];
  private glyphs: Glyph[] = [];
  private preview: Annotation | null = null;
  private releaseCamera: (() => void) | null = null;
  /** A dimension just made, whose number should be waiting to be typed over. */
  private pendingLabel: string | null = null;

  /** Where each dimension was dragged to, by name. */
  private places = new Map<string, Place>();
  /** The dimension tool's own panel, and the state behind it. */
  private readonly dialogue: HTMLElement;
  private readonly dialogueStep: HTMLElement;
  private readonly dialogueValue: HTMLElement;
  private readonly kindButtons = new Map<SpanKind, HTMLButtonElement>();
  private placing: Placing | null = null;
  private grab: Grab | null = null;

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
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'sketch-labels';
    this.labelLayer.hidden = true;
    container.append(this.labelLayer);

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

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tool-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => this.deletePicked());
    relations.row.append(remove);

    this.dialogue = document.createElement('div');
    this.dialogue.className = 'sketch-dialogue';
    this.dialogue.hidden = true;

    const dialogueTitle = document.createElement('div');
    dialogueTitle.className = 'sketch-group-label';
    dialogueTitle.textContent = 'Dimension';

    this.dialogueStep = document.createElement('div');
    this.dialogueStep.className = 'sketch-dialogue-step';

    const kinds = document.createElement('div');
    kinds.className = 'sketch-tools';
    for (const kind of SPAN_KINDS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button';
      button.textContent = kind.label;
      button.addEventListener('click', () => this.pinKind(kind.id));
      this.kindButtons.set(kind.id, button);
      kinds.append(button);
    }

    this.dialogueValue = document.createElement('div');
    this.dialogueValue.className = 'sketch-dialogue-value';

    this.dialogue.append(dialogueTitle, this.dialogueStep, kinds, this.dialogueValue);

    this.previewLabel = document.createElement('div');
    this.previewLabel.className = 'sketch-label sketch-label-preview';
    this.previewLabel.hidden = true;
    this.labelLayer.append(this.previewLabel);

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

    // The dimension tool's panel goes directly under the tools, rather than
    // below the relations: it belongs to the tool in hand, and a panel that
    // opens below the fold has not opened as far as the person is concerned.
    this.panel.append(
      heading,
      draw.el,
      this.dialogue,
      relations.el,
      this.hintEl,
      this.listEl,
      actions,
    );

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onDragMove = this.onDragMove.bind(this);
    this.onDragUp = this.onDragUp.bind(this);
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

  /**
   * The relation marks currently on the drawing and where each one sits. Like
   * the solved points, this is here because nothing else can say it: the marks
   * are placed from the geometry as it stands, so anything checking that they
   * can be clicked has to be told where they ended up.
   */
  drawnRules(): ReadonlyArray<{ constraint: number; kind: string; at: Point }> {
    return this.glyphs.map(({ constraint, kind, at }) => ({ constraint, kind, at }));
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
    this.places = decodePlaces(node.inputs.places);
    this.nodeId = nodeId;
    this.plane = plane;
    this.picked = [];
    this.chain = [];
    this.cursor = null;
    this.placing = null;
    this.endGrab();

    this.panel.hidden = false;
    this.labelLayer.hidden = false;
    this.releaseCamera = this.viewport.onCameraChange(() => this.placeLabels());
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

    this.endGrab();
    this.nodeId = null;
    this.plane = null;
    this.draft = null;
    this.picked = [];
    this.chain = [];
    this.result = null;
    this.placing = null;
    this.places = new Map();

    this.releaseCamera?.();
    this.releaseCamera = null;
    this.labelLayer.hidden = true;
    for (const field of this.labels.values()) field.parentElement?.remove();
    this.labels.clear();
    this.previewLabel.hidden = true;
    this.annotations = [];
    this.glyphs = [];
    this.preview = null;

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
    this.graph.setInput(nodeId, 'places', encodePlaces(this.places) as Value[]);
    for (const [name, value] of draft.dimensions) {
      this.graph.setInput(nodeId, dimensionPort(name), value);
    }

    this.callbacks.onChanged();
  }

  // --------------------------------------------------------------- tools

  private setTool(tool: ToolId): void {
    this.tool = tool;
    this.chain = [];
    this.placing = null;
    if (tool !== 'select' && tool !== 'dimension') this.picked = [];

    // The dimension tool keeps whatever is already picked: pressing it with a
    // line selected is the short way to dimension that line, and what it picked
    // up goes straight to being placed.
    // Placed automatically to begin with: the last place the cursor went was a
    // pick, which says nothing about where the dimension should sit. Moving the
    // cursor is what says that.
    this.cursor = null;
    if (tool === 'dimension') this.placing = this.buildPlacing(null, null);

    for (const [id, button] of this.toolButtons) button.classList.toggle('is-active', id === tool);
    this.hintEl.textContent = DRAW_TOOLS.find((entry) => entry.id === tool)?.hint ?? '';
    this.render();

    // The panel is taller than the room it has and scrolls. A panel that opens
    // below the fold has not opened as far as the person is concerned.
    if (tool === 'dimension') this.dialogue.scrollIntoView({ block: 'nearest' });
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

  // ----------------------------------------------------------- dimensions

  /**
   * What the current picks would measure, and where it would sit.
   *
   * Rebuilt on every movement of the cursor while a dimension is in the air,
   * because until it is dropped the cursor is still deciding what it measures:
   * a diagonal put out to its side reads as its length, put above it as the
   * width it covers, and put beside it as the height.
   */
  private buildPlacing(at: Point | null, pinned: SpanKind | null): Placing | null {
    const draft = this.draft;
    const solved = this.result;
    if (draft === null || solved === null) return null;

    const sketch = draft.sketch;
    const chosenLines = lines(this.picked);
    const chosenPoints = points(this.picked);

    if (chosenLines.length === 2 && chosenLines.every((index) => isLine(sketch, index))) {
      const constraint: Constraint = {
        kind: 'angle',
        a: chosenLines[0]!,
        b: chosenLines[1]!,
        dimension: PENDING,
      };
      return {
        constraint,
        place: at === null ? null : placeOf(sketch, constraint, solved.points, at),
        value: this.angleBetween(chosenLines[0]!, chosenLines[1]!),
        stem: 'angle',
        pinned: null,
      };
    }

    if (chosenLines.length === 1 && chosenPoints.length === 0 && isCircle(sketch, chosenLines[0]!)) {
      const constraint: Constraint = {
        kind: 'radius',
        circle: chosenLines[0]!,
        dimension: PENDING,
      };
      return {
        constraint,
        place: at === null ? null : placeOf(sketch, constraint, solved.points, at),
        value: solved.radii[chosenLines[0]!]!,
        stem: 'radius',
        pinned: null,
      };
    }

    let a: number;
    let b: number;
    let stem: string;
    if (chosenLines.length === 1 && chosenPoints.length === 0 && isLine(sketch, chosenLines[0]!)) {
      const entity = sketch.entities[chosenLines[0]!]!;
      if (entity.kind !== 'line') return null;
      a = entity.a;
      b = entity.b;
      stem = 'length';
    } else if (chosenPoints.length === 2 && chosenLines.length === 0) {
      a = chosenPoints[0]!;
      b = chosenPoints[1]!;
      stem = 'distance';
    } else {
      return null;
    }

    let from = solved.points[a]!;
    let to = solved.points[b]!;
    const kind: SpanKind =
      pinned ?? (at === null ? 'distance' : chooseSpan(from, to, at).kind);

    // A component is measured with its sign, so the two ends are put in the
    // order that makes it positive. Written the other way round the number
    // would be the negative of what it reads, and applying it would turn the
    // geometry back to front rather than resize it.
    const backwards =
      (kind === 'horizontalDistance' && to.u < from.u) ||
      (kind === 'verticalDistance' && to.v < from.v);
    if (backwards) {
      [a, b] = [b, a];
      [from, to] = [to, from];
    }

    return {
      constraint: { kind, a, b, dimension: PENDING },
      place: at === null ? null : placeOfSpan(kind, from, to, at),
      value: measureOf(kind, from, to),
      stem:
        kind === 'horizontalDistance' ? 'width' : kind === 'verticalDistance' ? 'height' : stem,
      pinned,
    };
  }

  /** One click of the dimension tool: picking what to measure, then placing it. */
  private dimensionClick(at: Point): void {
    const draft = this.draft;
    if (draft === null) return;
    const sketch = draft.sketch;
    const hit = this.nearest(at, this.slack());

    if (this.placing !== null) {
      // A second line turns a length into an angle, which is the one click that
      // is not a placement.
      const already = this.picked;
      const only = already.length === 1 ? already[0] : undefined;
      if (
        hit !== null &&
        hit.kind === 'entity' &&
        isLine(sketch, hit.index) &&
        only !== undefined &&
        only.kind === 'entity' &&
        isLine(sketch, only.index) &&
        hit.index !== only.index
      ) {
        this.picked = [...already, hit];
        this.placing = this.buildPlacing(at, null);
        this.render();
        return;
      }

      this.commitDimension();
      return;
    }

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

    this.placing = this.buildPlacing(at, null);
    this.render();
  }

  /** Puts the dimension in the air where it is, and asks for its number. */
  private commitDimension(): boolean {
    const pending = this.placing;
    const draft = this.draft;
    if (pending === null || draft === null) return false;

    const name = uniqueName(draft.dimensions, pending.stem);
    const constraint = { ...pending.constraint, dimension: name } as Constraint;

    this.placing = null;
    draft.dimensions.set(name, pending.value);
    if (pending.place !== null) this.places.set(name, pending.place);

    if (!this.tryAdding([constraint], 'Dimension')) {
      draft.dimensions.delete(name);
      this.places.delete(name);
      this.picked = [];
      this.render();
      return false;
    }

    // Straight into typing over it, which is the whole point of putting the
    // number on the drawing.
    this.pendingLabel = name;
    this.render();
    return true;
  }

  /** Says which of the three a span means, instead of letting the cursor say. */
  private pinKind(kind: SpanKind): void {
    if (this.placing === null || !isSpanKind(this.placing.constraint.kind)) return;
    this.placing = this.buildPlacing(this.cursor, kind);
    this.render();
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

    // Rules go first and from the back, so removing one does not move the index
    // of the next one along.
    const rules = this.picked
      .filter((entry) => entry.kind === 'constraint')
      .map((entry) => entry.index)
      .sort((a, b) => b - a);

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
    for (const index of rules) this.forget(index);
    if (entities.length > 0 || loose.size > 0) removeParts(draft, entities, [...loose]);
    for (const name of this.places.keys()) {
      if (!draft.dimensions.has(name)) this.places.delete(name);
    }
    this.picked = [];
    this.chain = [];
    this.resolve();
    this.commit();
    this.hintEl.textContent = 'Deleted.';
  }

  /**
   * Takes one rule out of the sketch, and the number it drove with it if no
   * other rule still uses that number. Everything around it is left alone: the
   * caller decides when to solve and write back.
   */
  private forget(index: number): void {
    const draft = this.draft;
    if (draft === null) return;

    const [removed] = draft.sketch.constraints.splice(index, 1);
    if (removed === undefined || !('dimension' in removed)) return;

    const stillUsed = draft.sketch.constraints.some(
      (other) => 'dimension' in other && other.dimension === removed.dimension,
    );
    if (!stillUsed) {
      draft.dimensions.delete(removed.dimension);
      this.places.delete(removed.dimension);
    }
  }

  private removeConstraint(index: number): void {
    const draft = this.draft;
    if (draft === null) return;

    this.forget(index);
    this.picked = this.picked.filter((entry) => entry.kind !== 'constraint');

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
    if (this.tool === 'dimension') {
      if (this.placing === null) return;
      this.placing = this.buildPlacing(this.cursor, this.placing.pinned);
      this.render();
      return;
    }
    this.renderPreview();
  }

  private onPointerDown(event: PointerEvent): void {
    const draft = this.draft;
    if (draft === null || this.result === null || event.button !== 0) return;

    const at = this.snapped(event.clientX, event.clientY);
    if (at === null) return;
    event.preventDefault();
    this.cursor = at;

    if (this.tool === 'dimension') {
      this.dimensionClick(at);
      return;
    }

    if (this.tool !== 'select') {
      this.draw(at);
      return;
    }

    // Held still, a press picks what is under it. Moved, it drags it: geometry
    // as far as its rules allow, a dimension to wherever reads best.
    const found = this.nearest(at, this.slack());
    const rule = found === null ? this.constraintAt(at, this.slack()) : null;
    const hit: Selection | null =
      found ?? (rule === null ? null : { kind: 'constraint', index: rule.index });
    this.startGrab(
      {
        hit,
        // Only a dimension can be dragged: a relation's glyph is placed by what
        // it belongs to, which has nowhere of its own to be put.
        dimension:
          rule === null || rule.name === null
            ? null
            : { name: rule.name, constraint: rule.constraint },
        screen: { x: event.clientX, y: event.clientY },
        at,
        moved: false,
        pulls: [],
        field: null,
      },
      event.pointerId,
    );
  }

  // ---------------------------------------------------------------- dragging

  private startGrab(grab: Grab, pointerId: number | null): void {
    this.endGrab();
    this.grab = grab;
    if (pointerId !== null) {
      try {
        this.viewport.canvas.setPointerCapture(pointerId);
      } catch {
        // No capture is a nuisance, not a failure: the document listeners below
        // still see the drag out.
      }
    }
    document.addEventListener('pointermove', this.onDragMove);
    document.addEventListener('pointerup', this.onDragUp);
  }

  private endGrab(): void {
    this.grab = null;
    document.removeEventListener('pointermove', this.onDragMove);
    document.removeEventListener('pointerup', this.onDragUp);
  }

  private onDragMove(event: PointerEvent): void {
    const grab = this.grab;
    if (grab === null || this.draft === null) return;

    if (!grab.moved) {
      const travelled = Math.hypot(event.clientX - grab.screen.x, event.clientY - grab.screen.y);
      if (travelled < DRAG_SLACK) return;
      if (!this.beginDrag(grab)) {
        this.endGrab();
        return;
      }
      grab.moved = true;
    }

    const at = this.snapped(event.clientX, event.clientY);
    if (at === null) return;

    if (grab.dimension !== null) {
      const place = placeOf(
        this.draft.sketch,
        grab.dimension.constraint,
        this.result?.points ?? [],
        at,
      );
      if (place !== null) this.places.set(grab.dimension.name, place);
      this.render();
      return;
    }

    // Everything dragged moves by the same amount, so a line keeps its length
    // unless something else makes it change.
    const pull: Pull[] = grab.pulls.map(({ point, from }) => ({
      point,
      to: { u: from.u + (at.u - grab.at.u), v: from.v + (at.v - grab.at.v) },
    }));
    this.result = solveSketch(this.draft.sketch, this.draft.dimensions, { pull });
    this.render();
  }

  private onDragUp(): void {
    const grab = this.grab;
    if (grab === null) return;
    this.endGrab();

    if (!grab.moved) {
      this.pick(grab.hit);
      return;
    }

    if (grab.dimension !== null) {
      this.commit();
      this.hintEl.textContent = 'Dimension moved.';
      return;
    }

    // What the drag arrived at is where the sketch now is.
    this.sync();
    this.after();
    this.hintEl.textContent = this.result?.solved === true ? 'Moved.' : 'These rules cannot all hold';
  }

  /** Works out what a press that has started moving is actually dragging. */
  private beginDrag(grab: Grab): boolean {
    const draft = this.draft;
    const solved = this.result;
    if (draft === null || solved === null) return false;

    if (grab.dimension !== null) {
      grab.field?.blur();
      this.callbacks.onBeforeChange();
      return true;
    }

    const moving: number[] = [];
    if (grab.hit?.kind === 'point') moving.push(grab.hit.index);
    else if (grab.hit?.kind === 'entity') {
      const entity = draft.sketch.entities[grab.hit.index];
      if (entity === undefined) return false;
      if (entity.kind === 'circle') moving.push(entity.centre);
      else moving.push(entity.a, entity.b);
    } else {
      return false;
    }

    // Dragging works from where the solver has the points, not from where they
    // were last written down, or the first movement would jump.
    this.sync();
    grab.pulls = moving.map((point) => ({ point, from: { ...solved.points[point]! } }));
    this.callbacks.onBeforeChange();
    return true;
  }

  /** A press that never moved: the old, plain business of selecting something. */
  private pick(hit: Selection | null): void {
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

  /**
   * The rule under a point on the drawing: a dimension by its lines or its
   * number, a relation by its glyph. Dimensions carry a name, which is what
   * says whether the thing can also be dragged.
   */
  private constraintAt(
    at: Point,
    slack: number,
  ): { index: number; name: string | null; constraint: Constraint } | null {
    const draft = this.draft;
    if (draft === null) return null;

    let best: { index: number; name: string | null } | null = null;
    let bestDistance = slack;

    for (const entry of this.annotations) {
      let distance = Math.hypot(entry.label.u - at.u, entry.label.v - at.v);
      for (const [from, to] of entry.lines) {
        distance = Math.min(distance, distanceToSegment(at, from, to));
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { index: entry.constraint, name: entry.dimension };
      }
    }

    // A glyph is a small solid thing rather than a line to be near, so the whole
    // box it is drawn in counts as a hit.
    const reach = this.plane === null ? slack : glyphReach(this.viewport.pickTolerance(this.plane, 1));
    for (const glyph of this.glyphs) {
      const distance = Math.hypot(glyph.at.u - at.u, glyph.at.v - at.v);
      if (distance > reach) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { index: glyph.constraint, name: null };
      }
    }

    if (best === null) return null;
    const constraint = draft.sketch.constraints[best.index];
    if (constraint === undefined) return null;
    return { ...best, constraint };
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
    const target = event.target as HTMLElement | null;
    const typing =
      target !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    // Delete takes away what is picked, rules included: click a dimension or a
    // relation's glyph and press it. Not while a number is being typed, where
    // the same key means the character to the right.
    if ((event.key === 'Delete' || event.key === 'Backspace') && !typing) {
      event.preventDefault();
      this.deletePicked();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      this.chain = [];
      this.renderPreview();
      return;
    }

    if (event.key !== 'Escape') return;
    event.preventDefault();

    // Escape backs out one step at a time: the dimension in the air, then the
    // chain in hand, then the tool, then the picks, and only then the session.
    if (this.placing !== null) {
      this.placing = null;
      this.picked = [];
      this.render();
      return;
    }
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
    this.renderAnnotations(solved);
    this.renderPreview();
    this.renderPanel(solved);
    this.renderDialogue();
  }

  /**
   * Draws the dimensions on the sketch, and puts their numbers over the canvas
   * as fields.
   *
   * The lines go in the scene and the numbers do not: a number you can click
   * into and type over is worth more than one baked into the geometry, and it
   * is the whole of what makes a dimension feel like a dimension rather than a
   * row in a list.
   */
  private renderAnnotations(solved: SolveResult): void {
    const draft = this.draft;
    const plane = this.plane;
    if (draft === null || plane === null) return;

    // Sizes are given in pixels, so they need what a pixel is worth here.
    const scale = this.viewport.pickTolerance(plane, 1);
    this.annotations = annotate(
      draft.sketch,
      solved.points,
      solved.radii,
      draft.dimensions,
      scale,
      this.places,
    );

    // The one being placed is drawn the same way as the ones already there, so
    // what is being dragged around is exactly what gets left behind.
    this.preview =
      this.placing === null
        ? null
        : annotateOne(
            draft.sketch,
            this.placing.constraint,
            -1,
            solved.points,
            solved.radii,
            this.placing.value,
            scale,
            this.placing.place ?? undefined,
            { u: 0, v: 0 },
          );

    // The relations, which have no number to show themselves with.
    this.glyphs = glyphsFor(draft.sketch, solved.points, scale);

    const isPicked = (constraint: number): boolean =>
      this.picked.some((entry) => entry.kind === 'constraint' && entry.index === constraint);

    const flat: Array<[Vec3, Vec3]> = [];
    const picked: Array<[Vec3, Vec3]> = [];
    const add = (constraint: number, drawn: ReadonlyArray<readonly [Point, Point]>): void => {
      const into = isPicked(constraint) ? picked : flat;
      for (const [from, to] of drawn) {
        into.push([pointOnPlane(plane, from.u, from.v), pointOnPlane(plane, to.u, to.v)]);
      }
    };

    for (const entry of this.annotations) add(entry.constraint, entry.lines);
    for (const glyph of this.glyphs) add(glyph.constraint, glyph.lines);
    if (this.preview !== null) add(-1, this.preview.lines);

    this.viewport.setSketchAnnotations(flat, picked);

    this.syncLabels();
    this.placeLabels();
  }

  /** One field per drawn dimension, made and dropped as dimensions come and go. */
  private syncLabels(): void {
    const wanted = new Set(this.annotations.map((entry) => entry.dimension));

    for (const [name, field] of this.labels) {
      if (wanted.has(name)) continue;
      field.parentElement?.remove();
      this.labels.delete(name);
    }

    for (const entry of this.annotations) {
      let field = this.labels.get(entry.dimension);
      if (field === undefined) {
        const holder = document.createElement('div');
        holder.className = 'sketch-label';

        field = document.createElement('input');
        field.type = 'text';
        field.inputMode = 'decimal';
        field.className = 'sketch-label-field';
        field.dataset.dimension = entry.dimension;
        field.addEventListener('change', () => this.readLabel(entry.dimension));
        field.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            field!.blur();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            field!.blur();
          }
          // Everything else is typing, and typing here is not the view's.
          event.stopPropagation();
        });

        // Dragging the number moves the dimension; clicking it types over the
        // number. Which one it was is not known until the pointer either moves
        // or does not, so the press starts as neither.
        const name = entry.dimension;
        holder.addEventListener('pointerdown', (event) => this.grabLabel(event, name));
        // One click picks the dimension, which is what makes Delete mean the
        // dimension rather than the character to the right of the caret. Two
        // clicks is how you get at the number itself.
        holder.addEventListener('dblclick', () => {
          field!.focus();
          field!.select();
        });
        // A number just placed is focused with its text selected, and dragging
        // selected text is a drag of the text as far as the browser is
        // concerned: it swallows the pointer and never lets go of it. Refusing
        // that leaves the press to mean what it means here.
        holder.addEventListener('dragstart', (event) => event.preventDefault());

        holder.append(field);
        this.labelLayer.append(holder);
        this.labels.set(entry.dimension, field);
      }

      // Not while it is being typed into: that is the person's text, not ours.
      if (document.activeElement !== field) field.value = entry.text;
      field.size = Math.max(entry.text.length, 2);
      field.classList.toggle(
        'is-picked',
        this.picked.some((pick) => pick.kind === 'constraint' && pick.index === entry.constraint),
      );
    }

    const pending = this.pendingLabel;
    this.pendingLabel = null;
    if (pending === null) return;

    const field = this.labels.get(pending);
    if (field === undefined) return;
    field.focus();
    field.select();
  }

  /** Puts each number where its dimension is, which the view moving changes. */
  private placeLabels(): void {
    const plane = this.plane;
    if (plane === null || this.labelLayer.hidden) return;

    const bounds = this.labelLayer.getBoundingClientRect();

    this.previewLabel.hidden = this.preview === null;
    if (this.preview !== null) {
      this.previewLabel.textContent = this.preview.text;
      const at = this.viewport.screenPositionOf(
        pointOnPlane(plane, this.preview.label.u, this.preview.label.v),
      );
      this.previewLabel.style.left = `${at.x - bounds.left}px`;
      this.previewLabel.style.top = `${at.y - bounds.top}px`;
    }

    for (const entry of this.annotations) {
      const field = this.labels.get(entry.dimension);
      const holder = field?.parentElement;
      if (holder === null || holder === undefined) continue;

      const at = this.viewport.screenPositionOf(
        pointOnPlane(plane, entry.label.u, entry.label.v),
      );
      holder.style.left = `${at.x - bounds.left}px`;
      holder.style.top = `${at.y - bounds.top}px`;
    }
  }

  /** Taking hold of a dimension by its number, to move it rather than type it. */
  private grabLabel(event: PointerEvent, name: string): void {
    const draft = this.draft;
    if (draft === null || event.button !== 0) return;

    const index = draft.sketch.constraints.findIndex(
      (constraint) => 'dimension' in constraint && constraint.dimension === name,
    );
    const constraint = draft.sketch.constraints[index];
    if (constraint === undefined) return;

    const at = this.snapped(event.clientX, event.clientY);
    if (at === null) return;

    // A press on a number that is not already being typed into does not put the
    // caret there: it picks the dimension, and a second click asks for the
    // number. A press on one that is being typed into is left alone.
    const field = this.labels.get(name) ?? null;
    if (document.activeElement !== field) event.preventDefault();

    this.startGrab(
      {
        hit: { kind: 'constraint', index },
        dimension: { name, constraint },
        screen: { x: event.clientX, y: event.clientY },
        at,
        moved: false,
        pulls: [],
        field,
      },
      null,
    );
  }

  /** The dimension tool's own panel: what to do next, and what it will measure. */
  private renderDialogue(): void {
    const active = this.tool === 'dimension';
    this.dialogue.hidden = !active;
    if (!active) return;

    const pending = this.placing;
    const span = pending !== null && isSpanKind(pending.constraint.kind);

    if (pending === null) {
      this.dialogueStep.textContent =
        this.picked.length === 0
          ? 'Pick a line, a circle, or two points.'
          : 'Pick one more, or a second line for an angle.';
      this.dialogueValue.textContent = '';
    } else {
      this.dialogueStep.textContent =
        pending.constraint.kind === 'angle'
          ? 'Move to set how far out the arc sits, then click.'
          : pending.constraint.kind === 'radius'
            ? 'Move to lay out the leader, then click.'
            : 'Move to place it, then click. Click another line instead for an angle.';
      this.dialogueValue.textContent =
        pending.constraint.kind === 'angle'
          ? `${formatLength(pending.value)}°`
          : `${formatLength(pending.value)} mm`;
    }

    for (const [kind, button] of this.kindButtons) {
      button.disabled = !span;
      button.classList.toggle('is-active', span && pending!.constraint.kind === kind);
    }
  }

  /** A number typed over a dimension is the dimension, as soon as it is typed. */
  private readLabel(name: string): void {
    const field = this.labels.get(name);
    if (field === undefined) return;

    const next = Number(field.value.replace(/[^0-9.+-]/g, ''));
    if (Number.isNaN(next)) {
      const entry = this.annotations.find((candidate) => candidate.dimension === name);
      field.value = entry?.text ?? field.value;
      return;
    }

    this.setDimension(name, next);
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

      const picked = this.picked.some(
        (entry) => entry.kind === 'constraint' && entry.index === index,
      );
      row.classList.toggle('is-picked', picked);

      const label = document.createElement('span');
      label.className = 'sketch-row-label';
      label.textContent = describe(constraint);
      // The row and the mark on the drawing are the same rule seen twice, so
      // picking it in one place picks it in the other.
      label.addEventListener('click', () => this.pick({ kind: 'constraint', index }));
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
