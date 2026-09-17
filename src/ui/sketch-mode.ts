import type { Graph } from '../core/graph.js';
import type { NodeId, PlaneValue, Value, Vec3 } from '../core/types.js';
import { pointOnPlane } from '../geometry/plane.js';
import { inferCircle, inferDimensions, inferSketch } from '../sketch/infer.js';
import { encodeSketch } from '../sketch/model.js';
import type { Viewport } from '../viewport.js';
import type { PlaneChoice } from './features.js';
import { placeDownstream, resolvePlaneSource } from './features.js';

type Tool = 'line' | 'rectangle' | 'circle';

interface Point {
  u: number;
  v: number;
}

export interface SketchModeCallbacks {
  onBeforeChange(): void;
  onFinish(nodeId: NodeId): void;
  onExit(): void;
}

const TOOLS: Array<{ id: Tool; label: string; hint: string }> = [
  { id: 'line', label: 'Line', hint: 'Click points. Click the first point again, or press Enter, to close.' },
  { id: 'rectangle', label: 'Rectangle', hint: 'Click one corner, then the opposite corner.' },
  { id: 'circle', label: 'Circle', hint: 'Click the centre, then a point on the circle.' },
];

const SNAP = 1;
const CIRCLE_SEGMENTS = 48;

function distance(a: Point, b: Point): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

function rectangleCorners(a: Point, b: Point): Point[] {
  return [
    { u: a.u, v: a.v },
    { u: b.u, v: a.v },
    { u: b.u, v: b.v },
    { u: a.u, v: b.v },
  ];
}

function circlePoints(centre: Point, radius: number): Point[] {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, index) => {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2;
    return { u: centre.u + Math.cos(angle) * radius, v: centre.v + Math.sin(angle) * radius };
  });
}

export class SketchMode {
  private readonly panel: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();

  private plane: PlaneValue | null = null;
  private source: PlaneChoice | null = null;
  private tool: Tool = 'line';
  private points: Point[] = [];
  private cursor: Point | null = null;

  constructor(
    container: HTMLElement,
    private readonly graph: Graph,
    private readonly viewport: Viewport,
    private readonly callbacks: SketchModeCallbacks,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'sketch-panel';
    this.panel.hidden = true;

    const title = document.createElement('div');
    title.className = 'feature-title';
    title.textContent = 'Sketch';

    const tools = document.createElement('div');
    tools.className = 'sketch-tools';
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tool-button';
      button.textContent = tool.label;
      button.addEventListener('click', () => this.setTool(tool.id));
      this.toolButtons.set(tool.id, button);
      tools.append(button);
    }

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'feature-message';

    const actions = document.createElement('div');
    actions.className = 'feature-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tool-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.exit());

    const finish = document.createElement('button');
    finish.type = 'button';
    finish.className = 'tool-button tool-primary';
    finish.textContent = 'Finish';
    finish.addEventListener('click', () => this.finish());

    actions.append(cancel, finish);
    this.panel.append(title, tools, this.hintEl, actions);
    container.append(this.panel);

    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
  }

  get isActive(): boolean {
    return this.plane !== null;
  }

  enter(plane: PlaneValue, source: PlaneChoice): void {
    this.plane = plane;
    this.source = source;
    this.points = [];
    this.cursor = null;
    this.tool = 'line';

    this.panel.hidden = false;
    this.viewport.setPickingEnabled(false);
    this.viewport.setDimmed(true);
    this.viewport.alignToPlane(plane);

    this.viewport.canvas.addEventListener('pointermove', this.onPointerMove);
    this.viewport.canvas.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('keydown', this.onKeyDown);

    this.setTool('line');
  }

  exit(): void {
    if (this.plane === null) return;

    this.viewport.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.viewport.canvas.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('keydown', this.onKeyDown);

    this.plane = null;
    this.source = null;
    this.points = [];
    this.cursor = null;

    this.panel.hidden = true;
    this.viewport.clearSketchPreview();
    this.viewport.setDimmed(false);
    this.viewport.setPickingEnabled(true);
    this.viewport.releasePlaneAlignment();
    this.callbacks.onExit();
  }

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.points = [];
    for (const [id, button] of this.toolButtons) button.classList.toggle('is-active', id === tool);
    this.hintEl.textContent = TOOLS.find((entry) => entry.id === tool)?.hint ?? '';
    this.refreshPreview();
  }

  private snapped(clientX: number, clientY: number): Point | null {
    if (this.plane === null) return null;
    const raw = this.viewport.planePoint(clientX, clientY, this.plane);
    if (raw === null) return null;
    return { u: Math.round(raw.u / SNAP) * SNAP, v: Math.round(raw.v / SNAP) * SNAP };
  }

  private onPointerMove(event: PointerEvent): void {
    this.cursor = this.snapped(event.clientX, event.clientY);
    this.refreshPreview();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const point = this.snapped(event.clientX, event.clientY);
    if (point === null) return;
    event.preventDefault();

    const first = this.points[0];

    if (this.tool === 'line') {
      if (first !== undefined && this.points.length >= 3 && distance(point, first) <= SNAP * 1.5) {
        this.finish();
        return;
      }
      this.points.push(point);
      this.refreshPreview();
      return;
    }

    if (first === undefined) {
      this.points.push(point);
      this.refreshPreview();
      return;
    }

    if (this.tool === 'rectangle') {
      if (point.u === first.u || point.v === first.v) {
        this.hintEl.textContent = 'That would be a zero-width rectangle.';
        return;
      }
      this.points = rectangleCorners(first, point);
      this.finish();
      return;
    }

    const radius = distance(first, point);
    if (radius < SNAP) {
      this.hintEl.textContent = 'Move further from the centre to set a radius.';
      return;
    }
    this.finish();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.exit();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.finish();
    }
  }

  private previewUV(): { uv: Point[]; closed: boolean } {
    const first = this.points[0];

    if (this.tool === 'rectangle' && first !== undefined && this.cursor !== null) {
      return { uv: rectangleCorners(first, this.cursor), closed: true };
    }
    if (this.tool === 'circle' && first !== undefined && this.cursor !== null) {
      return { uv: circlePoints(first, distance(first, this.cursor)), closed: true };
    }

    const uv = [...this.points];
    if (this.cursor !== null) uv.push(this.cursor);
    return { uv, closed: false };
  }

  private refreshPreview(): void {
    const plane = this.plane;
    if (plane === null) return;

    const { uv, closed } = this.previewUV();
    const world: Vec3[] = uv.map((point) => pointOnPlane(plane, point.u, point.v));
    this.viewport.setSketchPreview(world, closed);
  }

  private finish(): void {
    const plane = this.plane;
    const source = this.source;
    if (plane === null || source === null) return;

    const first = this.points[0];
    if (first === undefined) {
      this.hintEl.textContent = 'Nothing drawn yet.';
      return;
    }

    const isCircle = this.tool === 'circle';
    if (isCircle && this.cursor === null) {
      this.hintEl.textContent = 'Set a radius first.';
      return;
    }
    if (!isCircle && this.points.length < 3) {
      this.hintEl.textContent = 'A profile needs at least three points.';
      return;
    }

    this.callbacks.onBeforeChange();
    const created: NodeId[] = [];

    try {
      const planePort = resolvePlaneSource(this.graph, source, created);

      // What was drawn becomes a constrained sketch: the relations the drawing
      // shows, and the dimensions the shape can honestly be named by.
      const radius = isCircle ? distance(first, this.cursor!) : 0;
      const model = isCircle ? inferCircle(first, radius) : inferSketch(this.points);
      const encoded = encodeSketch(model);
      const node = this.graph.addNode('sketch.constrained', {
        inputs: {
          points: encoded.points,
          entities: encoded.entities as Value[],
          constraints: encoded.constraints as Value[],
          dims: inferDimensions(model, isCircle ? [first] : this.points, radius) as Value[],
        },
      });

      created.push(node.id);
      this.graph.connect(planePort, { node: node.id, port: 'plane' });
      placeDownstream(this.graph, node.id);

      this.exit();
      this.callbacks.onFinish(node.id);
    } catch (thrown) {
      for (const nodeId of created.reverse()) this.graph.removeNode(nodeId);
      this.hintEl.textContent = thrown instanceof Error ? thrown.message : String(thrown);
    }
  }
}
