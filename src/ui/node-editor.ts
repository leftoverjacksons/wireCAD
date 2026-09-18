import type { NodeStatus } from '../core/evaluator.js';
import type { Graph, GraphChange } from '../core/graph.js';
import { branchOf, removeAndHeal } from '../core/rewire.js';
import type { Edge, EdgeId, NodeId, NodeSchema, PortRef, Value } from '../core/types.js';
import { isPlane } from '../core/types.js';
import type { NodeReport } from '../worker/protocol.js';
import { nodeKind } from './kind.js';
import type { NodeMenuAction, NodeMenuItem } from './node-menu.js';
import { nodeMenu } from './node-menu.js';
import {
  HEADER_HEIGHT,
  NODE_WIDTH,
  ROW_HEIGHT,
  inputPortY,
  nodeHeight,
  outputPortY,
  portCentreY,
  portLayout,
} from './metrics.js';

export interface NodeEditorCallbacks {
  /** Called immediately before a mutation, so history can snapshot the old state. */
  onBeforeChange(): void;
  onDocumentChanged(): void;
  onSelectionChanged(nodeId: NodeId | null): void;
  /**
   * Whether this node can be reopened, and doing so.
   *
   * What editing a feature means belongs to whoever owns the dialogs, not to
   * the graph view: today a sketch reopens its drawing session, and a feature
   * dialog that can load its own node will arrive behind the same two calls.
   */
  canEdit(nodeId: NodeId): boolean;
  onEdit(nodeId: NodeId): void;
  /**
   * Look at the model as it was at this node, or stop looking back.
   *
   * Which point the view is at belongs to whoever owns the viewport: the graph
   * view only says which node was asked for.
   */
  onRollBack(nodeId: NodeId | null): void;
}

interface NodeView {
  element: HTMLElement;
  schema: NodeSchema;
  statusEl: HTMLElement;
  fields: Map<string, HTMLInputElement>;
  eye: HTMLElement | null;
  /** The ports this view was drawn for, to notice when a node grows another. */
  ports: string;
}

type Drag =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; panX: number; panY: number }
  | {
      kind: 'node';
      pointerId: number;
      nodeId: NodeId;
      offsetX: number;
      offsetY: number;
      captured: boolean;
    }
  | { kind: 'wire'; pointerId: number; origin: PortRef; fromOutput: boolean };

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2.5;

/** What an unwired, non-numeric input is currently holding. */
function describeLiteral(value: Value): string {
  if (value === null) return 'unconnected';
  if (Array.isArray(value)) return `${value.length} values`;
  if (isPlane(value)) return 'plane';
  if (typeof value === 'object') return 'geometry';
  return String(value);
}

function wirePath(x1: number, y1: number, x2: number, y2: number): string {
  const reach = Math.max(60, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2} ${y2}`;
}

export class NodeEditor {
  private readonly canvas: HTMLElement;
  private readonly wireLayer: SVGSVGElement;
  private readonly hud: HTMLElement;

  private readonly views = new Map<NodeId, NodeView>();
  private readonly wires = new Map<EdgeId, { visible: SVGPathElement; hit: SVGPathElement }>();

  private ghost: SVGPathElement | null = null;
  private menu: HTMLElement | null = null;
  private drag: Drag | null = null;
  private selected: NodeId | null = null;

  private pan = { x: 60, y: 40 };
  private zoom = 1;

  private shownNodes = new Set<NodeId>();
  /** The point the view is rolled back to, and what that treats as absent. */
  private marker: NodeId | null = null;
  private beyond = new Set<NodeId>();

  constructor(
    private readonly container: HTMLElement,
    private readonly graph: Graph,
    private readonly callbacks: NodeEditorCallbacks,
  ) {
    this.container.classList.add('editor');
    this.container.tabIndex = 0;

    this.canvas = document.createElement('div');
    this.canvas.className = 'editor-canvas';

    this.wireLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.wireLayer.setAttribute('class', 'editor-wires');
    this.wireLayer.setAttribute('viewBox', '-10000 -10000 20000 20000');
    this.wireLayer.setAttribute('width', '20000');
    this.wireLayer.setAttribute('height', '20000');
    this.wireLayer.style.left = '-10000px';
    this.wireLayer.style.top = '-10000px';

    this.canvas.append(this.wireLayer);
    this.container.append(this.canvas);

    this.hud = document.createElement('div');
    this.hud.className = 'editor-hud';
    this.container.append(this.hud);

    this.container.addEventListener('pointerdown', (event) => this.onPointerDown(event));
    this.container.addEventListener('pointermove', (event) => this.onPointerMove(event));
    this.container.addEventListener('pointerup', (event) => this.onPointerUp(event));
    this.container.addEventListener('pointercancel', () => this.endDrag());
    this.container.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    this.container.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.container.addEventListener('contextmenu', (event) => this.onContextMenu(event));
    // A menu left open over a document that has moved on is a menu about
    // nothing, and the click outside it is how most menus are dismissed.
    window.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Node && this.container.contains(event.target)) return;
      this.closeMenu();
    });
    window.addEventListener('blur', () => this.closeMenu());

    graph.subscribe((change) => this.onGraphChange(change));

    this.rebuild();
    this.applyTransform();
  }

  /** Every port a node currently has, as one string to compare against. */
  private portSignature(nodeId: NodeId): string {
    const schema = this.graph.schemaOf(nodeId);
    return [...schema.inputs, ...schema.outputs].map((port) => port.id).join(',');
  }

  private onGraphChange(change: GraphChange): void {
    switch (change.kind) {
      case 'node-moved':
        this.positionNode(change.nodeId);
        this.redrawWiresFor(change.nodeId);
        break;
      case 'input-changed': {
        // A node whose ports depend on its own inputs may have just grown one
        // or lost one — a sketch dimension added or removed. Only then is the
        // node rebuilt, because rebuilding on every value would take the field
        // being typed in with it.
        const view = this.views.get(change.nodeId);
        if (view !== undefined && view.ports !== this.portSignature(change.nodeId)) {
          this.rebuild();
          break;
        }

        // Mirror the new value, but never fight the field the user is typing in.
        const field = view?.fields.get(change.portId);
        if (field !== undefined && document.activeElement !== field) {
          field.value = String(this.graph.inputValue(change.nodeId, change.portId) ?? 0);
        }
        break;
      }
      default:
        this.rebuild();
    }
  }

  /** Rename in place. Clearing the field puts the type's own name back. */
  private beginRename(nodeId: NodeId): void {
    const view = this.views.get(nodeId);
    const title = view?.element.querySelector('.node-title');
    if (view === undefined || !(title instanceof HTMLElement)) return;

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'node-rename';
    field.value = this.graph.requireNode(nodeId).label ?? '';
    field.placeholder = view.schema.label;
    field.addEventListener('pointerdown', (event) => event.stopPropagation());
    field.addEventListener('dblclick', (event) => event.stopPropagation());

    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      if (!commit) {
        field.replaceWith(title);
        return;
      }
      this.callbacks.onBeforeChange();
      // Renaming rebuilds the view, which is what removes the field.
      this.graph.setLabel(nodeId, field.value);
      this.callbacks.onDocumentChanged();
    };

    field.addEventListener('blur', () => finish(true));
    field.addEventListener('keydown', (event) => {
      // Keep typing away from the editor's own shortcuts.
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });

    title.replaceWith(field);
    field.focus();
    field.select();
  }

  // --------------------------------------------------------------------- menu

  /**
   * The menu a right-click on a node opens.
   *
   * Everything in it is something the graph can already do; what the menu adds
   * is saying what each one will cost before it is done. Deleting a fillet from
   * the middle of a chain and deleting the extrude the whole chain hangs on are
   * the same gesture on two nodes, and only the menu can tell them apart.
   */
  private onContextMenu(event: MouseEvent): void {
    const nodeEl = (event.target as HTMLElement).closest<HTMLElement>('.node');
    const nodeId = nodeEl?.dataset.nodeId;
    if (nodeId === undefined || this.graph.getNode(nodeId) === undefined) {
      this.closeMenu();
      return;
    }

    event.preventDefault();
    this.container.focus();
    this.select(nodeId);
    this.openMenu(nodeId, event.clientX, event.clientY);
  }

  private openMenu(nodeId: NodeId, clientX: number, clientY: number): void {
    this.closeMenu();

    const menu = document.createElement('div');
    menu.className = 'node-menu';
    menu.dataset.nodeId = nodeId;

    const heading = document.createElement('div');
    heading.className = 'node-menu-title';
    heading.textContent = this.graph.getNode(nodeId)?.label ?? this.graph.schemaOf(nodeId).label;
    menu.append(heading);

    const items = nodeMenu(this.graph, nodeId, {
      editable: this.callbacks.canEdit(nodeId),
      shown: this.shownNodes.has(nodeId),
      rolledBackTo: this.marker,
    });
    for (const item of items) menu.append(this.menuEntry(nodeId, item));

    this.container.append(menu);
    this.menu = menu;

    // Where the cursor is, pulled back inside when that would hang it off the
    // edge: a menu you have to scroll to reach is a menu you cannot use.
    const rect = this.container.getBoundingClientRect();
    const x = Math.min(clientX - rect.left, rect.width - menu.offsetWidth - 6);
    const y = Math.min(clientY - rect.top, rect.height - menu.offsetHeight - 6);
    menu.style.left = `${Math.max(6, x)}px`;
    menu.style.top = `${Math.max(6, y)}px`;
  }

  private menuEntry(nodeId: NodeId, item: NodeMenuItem): HTMLElement {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'node-menu-item';
    entry.dataset.action = item.action;
    if (item.divide === true) entry.classList.add('node-menu-divided');

    const label = document.createElement('span');
    label.className = 'node-menu-label';
    label.textContent = item.label;
    entry.append(label);

    const note = item.refusal ?? item.detail;
    if (note !== undefined) {
      const detail = document.createElement('span');
      detail.className = 'node-menu-detail';
      detail.textContent = note;
      entry.append(detail);
    }

    // An entry that would do nothing stays, saying why, rather than leaving a
    // gap that reads as the menu not having thought of it.
    if (item.refusal !== undefined) {
      entry.disabled = true;
      entry.title = item.refusal;
      return entry;
    }

    entry.addEventListener('click', () => this.runMenu(nodeId, item.action));
    return entry;
  }

  private runMenu(nodeId: NodeId, action: NodeMenuAction): void {
    this.closeMenu();
    if (this.graph.getNode(nodeId) === undefined) return;

    switch (action) {
      case 'edit':
        this.callbacks.onEdit(nodeId);
        return;
      case 'roll-back':
        this.callbacks.onRollBack(nodeId);
        return;
      case 'return':
        this.callbacks.onRollBack(null);
        return;
      case 'rename':
        this.beginRename(nodeId);
        return;
      case 'hide':
      case 'show':
        this.callbacks.onBeforeChange();
        this.graph.setVisibility(nodeId, action === 'show');
        this.callbacks.onDocumentChanged();
        return;
      case 'auto':
        this.callbacks.onBeforeChange();
        this.graph.setVisibility(nodeId, undefined);
        this.callbacks.onDocumentChanged();
        return;
      case 'suppress':
      case 'unsuppress':
        this.callbacks.onBeforeChange();
        this.graph.setSuppressed(nodeId, action === 'suppress');
        this.callbacks.onDocumentChanged();
        return;
      case 'delete':
        this.deleteNode(nodeId);
        return;
      case 'delete-branch':
        this.deleteBranch(nodeId);
        return;
    }
  }

  /**
   * Takes a node out and joins what it was reading to what was reading it.
   *
   * What became of the wires is the part of a deletion nobody can see — the
   * node it happened to has gone — so it is said out loud.
   */
  private deleteNode(nodeId: NodeId): void {
    this.callbacks.onBeforeChange();
    const { healed, stranded } = removeAndHeal(this.graph, nodeId);
    if (this.selected === nodeId) this.select(null);
    this.callbacks.onDocumentChanged();

    const said: string[] = [];
    if (healed > 0) said.push(`${healed} rewired`);
    if (stranded > 0) said.push(`${stranded} left without an input`);
    if (said.length > 0) this.notify(said.join(' · '), stranded > 0);
  }

  /** The node and everything that would have nothing left to read without it. */
  private deleteBranch(nodeId: NodeId): void {
    const going = branchOf(this.graph, nodeId);

    this.callbacks.onBeforeChange();
    for (const id of going) this.graph.removeNode(id);
    if (this.selected !== null && going.has(this.selected)) this.select(null);
    this.callbacks.onDocumentChanged();
    this.notify(`${going.size} node${going.size === 1 ? '' : 's'} deleted`, false);
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  // ---------------------------------------------------------------- rendering

  rebuild(): void {
    // The menu is about a node in the document as it was a moment ago.
    this.closeMenu();

    for (const view of this.views.values()) view.element.remove();
    this.views.clear();
    for (const wire of this.wires.values()) {
      wire.visible.remove();
      wire.hit.remove();
    }
    this.wires.clear();

    for (const node of this.graph.allNodes()) this.createNodeView(node.id);
    for (const edge of this.graph.allEdges()) this.createWire(edge);

    this.applySelection();
    this.applyRollback();
  }

  private createNodeView(nodeId: NodeId): void {
    const node = this.graph.requireNode(nodeId);
    const schema = this.graph.schemaOf(nodeId);

    const element = document.createElement('div');
    element.className = 'node';
    element.dataset.nodeId = nodeId;
    // Greyed, and still there: a suppressed feature is held back, not removed.
    if (node.suppressed === true) element.dataset.suppressed = 'true';
    element.style.width = `${NODE_WIDTH}px`;
    element.style.height = `${nodeHeight(schema)}px`;

    const header = document.createElement('div');
    header.className = 'node-header';
    header.style.height = `${HEADER_HEIGHT}px`;
    header.dataset.dragHandle = 'true';

    const title = document.createElement('span');
    title.className = 'node-title';
    title.textContent = node.label ?? schema.label;
    title.title = 'Double-click to rename';
    title.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginRename(nodeId);
    });

    // Colour and name the node by what it makes, so a Body reads as a Body.
    const kind = nodeKind(schema);
    let badge: HTMLElement | null = null;
    if (kind !== null) {
      element.dataset.kind = kind.type;
      badge = document.createElement('span');
      badge.className = 'node-kind';
      badge.textContent = kind.label;
    }

    const statusEl = document.createElement('span');
    statusEl.className = 'node-status';

    // Only a node that can put something on screen gets the control.
    const drawable = schema.outputs.some(
      (port) => port.type === 'geometry' || port.type === 'sketch',
    );
    let eye: HTMLElement | null = null;
    if (drawable) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'node-eye';
      button.title = 'Show or hide this result';
      button.textContent = '◉';
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.onBeforeChange();
        // The button reports what is on screen, so a click always means "do the
        // other thing" — which keeps it reversible without a third state.
        this.graph.setVisibility(nodeId, !this.shownNodes.has(nodeId));
        this.callbacks.onDocumentChanged();
      });
      eye = button;
    }

    header.append(title);
    if (badge !== null) header.append(badge);
    header.append(statusEl);
    if (eye !== null) header.append(eye);
    element.append(header);

    const fields = new Map<string, HTMLInputElement>();
    const layout = portLayout(schema);
    for (let row = 0; row < layout.rows; row++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'node-row';
      rowEl.style.top = `${HEADER_HEIGHT + row * ROW_HEIGHT}px`;
      rowEl.style.height = `${ROW_HEIGHT}px`;

      const input = layout.inputAt[row];
      if (input !== undefined) {
        const dot = document.createElement('div');
        dot.className = `port port-in type-${input.type}`;
        dot.dataset.nodeId = nodeId;
        dot.dataset.portId = input.id;
        dot.dataset.direction = 'input';
        dot.style.top = `${portCentreY(row)}px`;
        element.append(dot);

        const label = document.createElement('span');
        label.className = 'port-label';
        label.textContent = input.label;
        rowEl.append(label);

        const wired = this.graph.incomingEdge(nodeId, input.id) !== undefined;
        if (!wired && input.options !== undefined) {
          const choice = document.createElement('select');
          choice.className = 'port-choice';
          for (const option of input.options) {
            const item = document.createElement('option');
            item.value = option;
            item.textContent = option;
            choice.append(item);
          }
          choice.value = String(this.graph.inputValue(nodeId, input.id) ?? input.options[0]);
          choice.addEventListener('pointerdown', (event) => event.stopPropagation());
          choice.addEventListener('change', () => {
            this.callbacks.onBeforeChange();
            this.graph.setInput(nodeId, input.id, choice.value);
            this.callbacks.onDocumentChanged();
          });
          rowEl.append(choice);
        } else if (!wired && input.type === 'number') {
          const field = document.createElement('input');
          field.type = 'number';
          field.className = 'port-value';
          field.value = String(this.graph.inputValue(nodeId, input.id) ?? 0);
          field.addEventListener('pointerdown', (event) => event.stopPropagation());

          let captured = false;
          field.addEventListener('focus', () => {
            captured = false;
          });
          field.addEventListener('input', () => {
            const next = Number(field.value);
            if (Number.isNaN(next)) return;
            // One snapshot per editing session, not per keystroke.
            if (!captured) {
              captured = true;
              this.callbacks.onBeforeChange();
            }
            this.graph.setInput(nodeId, input.id, next);
            this.callbacks.onDocumentChanged();
          });
          rowEl.append(field);
          fields.set(input.id, field);
        } else if (!wired) {
          const hint = document.createElement('span');
          hint.className = 'port-hint';
          hint.textContent = describeLiteral(this.graph.inputValue(nodeId, input.id));
          rowEl.append(hint);
        }
      }

      const output = layout.outputAt[row];
      if (output !== undefined) {
        const dot = document.createElement('div');
        dot.className = `port port-out type-${output.type}`;
        dot.dataset.nodeId = nodeId;
        dot.dataset.portId = output.id;
        dot.dataset.direction = 'output';
        dot.style.top = `${portCentreY(row)}px`;
        element.append(dot);

        const label = document.createElement('span');
        label.className = 'output-label';
        label.textContent = output.label;
        rowEl.append(label);
      }

      element.append(rowEl);
    }

    this.canvas.append(element);
    this.views.set(nodeId, {
      element,
      schema,
      statusEl,
      fields,
      eye,
      ports: this.portSignature(nodeId),
    });
    this.positionNode(nodeId);
  }

  private positionNode(nodeId: NodeId): void {
    const view = this.views.get(nodeId);
    if (view === undefined) return;
    const node = this.graph.requireNode(nodeId);
    view.element.style.left = `${node.position.x}px`;
    view.element.style.top = `${node.position.y}px`;
  }

  private createWire(edge: Edge): void {
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'wire-hit');
    hit.dataset.edgeId = edge.id;

    const visible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    visible.setAttribute('class', 'wire');

    this.wireLayer.append(hit, visible);
    this.wires.set(edge.id, { visible, hit });
    this.updateWire(edge);
  }

  private updateWire(edge: Edge): void {
    const wire = this.wires.get(edge.id);
    if (wire === undefined) return;

    const source = this.graph.requireNode(edge.from.node);
    const target = this.graph.requireNode(edge.to.node);
    const sourceSchema = this.graph.schemaOf(edge.from.node);
    const targetSchema = this.graph.schemaOf(edge.to.node);

    const path = wirePath(
      source.position.x + NODE_WIDTH,
      source.position.y + outputPortY(sourceSchema, edge.from.port),
      target.position.x,
      target.position.y + inputPortY(targetSchema, edge.to.port),
    );

    wire.visible.setAttribute('d', path);
    wire.hit.setAttribute('d', path);
  }

  private redrawWiresFor(nodeId: NodeId): void {
    for (const edge of this.graph.incomingEdges(nodeId)) this.updateWire(edge);
    for (const edge of this.graph.outgoingEdges(nodeId)) this.updateWire(edge);
  }

  private applyTransform(): void {
    this.canvas.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.container.style.backgroundSize = `${22 * this.zoom}px ${22 * this.zoom}px`;
    this.container.style.backgroundPosition = `${this.pan.x}px ${this.pan.y}px`;
    this.hud.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  // -------------------------------------------------------------- interaction

  private toGraphPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.pan.x) / this.zoom,
      y: (event.clientY - rect.top - this.pan.y) / this.zoom,
    };
  }

  private onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('.node-menu') !== null) return;
    this.closeMenu();

    // Only the primary button works the canvas. Right-clicking a node's header
    // would otherwise start dragging it out from under its own menu.
    if (event.button !== 0) return;
    this.container.focus();

    const port = target.closest<HTMLElement>('.port');
    if (port !== null) {
      event.preventDefault();
      this.startWireDrag(event, port);
      return;
    }

    const wireHit = target.closest<SVGPathElement>('.wire-hit');
    if (wireHit !== null && wireHit.dataset.edgeId !== undefined) {
      event.preventDefault();
      this.callbacks.onBeforeChange();
      this.graph.disconnect(wireHit.dataset.edgeId);
      this.callbacks.onDocumentChanged();
      return;
    }

    const nodeEl = target.closest<HTMLElement>('.node');
    if (nodeEl !== null && nodeEl.dataset.nodeId !== undefined) {
      const nodeId = nodeEl.dataset.nodeId;
      this.select(nodeId);
      if (target.closest('[data-drag-handle]') !== null) {
        event.preventDefault();
        const node = this.graph.requireNode(nodeId);
        const point = this.toGraphPoint(event);
        this.drag = {
          kind: 'node',
          pointerId: event.pointerId,
          nodeId,
          offsetX: point.x - node.position.x,
          offsetY: point.y - node.position.y,
          captured: false,
        };
        this.container.setPointerCapture(event.pointerId);
      }
      return;
    }

    this.select(null);
    this.drag = {
      kind: 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: this.pan.x,
      panY: this.pan.y,
    };
    this.container.setPointerCapture(event.pointerId);
  }

  private startWireDrag(event: PointerEvent, port: HTMLElement): void {
    const nodeId = port.dataset.nodeId;
    const portId = port.dataset.portId;
    if (nodeId === undefined || portId === undefined) return;

    const isOutput = port.dataset.direction === 'output';
    let origin: PortRef = { node: nodeId, port: portId };

    if (!isOutput) {
      // Grabbing a connected input detaches the wire and keeps dragging its source.
      const existing = this.graph.incomingEdge(nodeId, portId);
      if (existing !== undefined) {
        origin = existing.from;
        this.callbacks.onBeforeChange();
        this.graph.disconnect(existing.id);
        this.callbacks.onDocumentChanged();
        this.beginGhost(event, origin, true);
        return;
      }
    }

    this.beginGhost(event, origin, isOutput);
  }

  private beginGhost(event: PointerEvent, origin: PortRef, fromOutput: boolean): void {
    this.drag = { kind: 'wire', pointerId: event.pointerId, origin, fromOutput };
    this.ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.ghost.setAttribute('class', 'wire wire-ghost');
    this.wireLayer.append(this.ghost);
    this.container.setPointerCapture(event.pointerId);
    this.updateGhost(event);
  }

  private updateGhost(event: PointerEvent): void {
    if (this.drag?.kind !== 'wire' || this.ghost === null) return;

    const node = this.graph.requireNode(this.drag.origin.node);
    const schema = this.graph.schemaOf(this.drag.origin.node);
    const cursor = this.toGraphPoint(event);

    if (this.drag.fromOutput) {
      const x = node.position.x + NODE_WIDTH;
      const y = node.position.y + outputPortY(schema, this.drag.origin.port);
      this.ghost.setAttribute('d', wirePath(x, y, cursor.x, cursor.y));
    } else {
      const x = node.position.x;
      const y = node.position.y + inputPortY(schema, this.drag.origin.port);
      this.ghost.setAttribute('d', wirePath(cursor.x, cursor.y, x, y));
    }
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== event.pointerId) return;

    if (drag.kind === 'pan') {
      this.pan.x = drag.panX + (event.clientX - drag.startX);
      this.pan.y = drag.panY + (event.clientY - drag.startY);
      this.applyTransform();
      return;
    }

    if (drag.kind === 'node') {
      const point = this.toGraphPoint(event);
      const next = {
        x: Math.round(point.x - drag.offsetX),
        y: Math.round(point.y - drag.offsetY),
      };
      const current = this.graph.requireNode(drag.nodeId).position;
      if (next.x === current.x && next.y === current.y) return;

      // One snapshot per drag, taken only once the node actually moves.
      if (!drag.captured) {
        drag.captured = true;
        this.callbacks.onBeforeChange();
      }
      this.graph.setPosition(drag.nodeId, next);
      return;
    }

    this.updateGhost(event);
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== event.pointerId) return;

    if (drag.kind === 'wire') {
      const dropped = document.elementFromPoint(event.clientX, event.clientY);
      const port = dropped?.closest<HTMLElement>('.port') ?? null;
      this.completeWire(drag, port);
    }

    this.endDrag();
  }

  private completeWire(drag: Extract<Drag, { kind: 'wire' }>, port: HTMLElement | null): void {
    if (port === null) return;
    const nodeId = port.dataset.nodeId;
    const portId = port.dataset.portId;
    const isOutput = port.dataset.direction === 'output';
    if (nodeId === undefined || portId === undefined) return;
    if (isOutput === drag.fromOutput) {
      this.flash('Connect an output to an input');
      return;
    }

    const target: PortRef = { node: nodeId, port: portId };
    const from = drag.fromOutput ? drag.origin : target;
    const to = drag.fromOutput ? target : drag.origin;

    const problem = this.graph.canConnect(from, to);
    if (problem !== null) {
      this.flash(problem);
      return;
    }

    this.callbacks.onBeforeChange();
    this.graph.connect(from, to);
    this.callbacks.onDocumentChanged();
  }

  private endDrag(): void {
    if (this.drag !== null) {
      try {
        this.container.releasePointerCapture(this.drag.pointerId);
      } catch {
        // The pointer may already have been released; nothing to undo.
      }
    }
    this.ghost?.remove();
    this.ghost = null;
    this.drag = null;
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.closeMenu();
    const rect = this.container.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    if (next === this.zoom) return;

    this.pan.x = cursorX - (cursorX - this.pan.x) * (next / this.zoom);
    this.pan.y = cursorY - (cursorY - this.pan.y) * (next / this.zoom);
    this.zoom = next;
    this.applyTransform();
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeMenu();
      return;
    }

    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if (this.selected === null) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;

    // The same deletion the menu offers, so the key and the entry mean one
    // thing: a fillet leaves the body it was rounding behind it.
    event.preventDefault();
    this.deleteNode(this.selected);
  }

  /** A line in the corner, where the zoom readout usually sits. */
  private notify(message: string, wrong: boolean): void {
    this.hud.textContent = message;
    this.hud.classList.toggle('editor-hud-error', wrong);
    window.setTimeout(() => {
      this.hud.classList.remove('editor-hud-error');
      this.applyTransform();
    }, 2200);
  }

  private flash(message: string): void {
    this.notify(message, true);
  }

  // ------------------------------------------------------------------ outward

  select(nodeId: NodeId | null): void {
    if (this.selected === nodeId) return;
    this.selected = nodeId;
    this.applySelection();
    this.callbacks.onSelectionChanged(nodeId);
  }

  setSelection(nodeId: NodeId | null): void {
    if (this.selected === nodeId) return;
    this.selected = nodeId;
    this.applySelection();
  }

  private applySelection(): void {
    for (const [nodeId, view] of this.views) {
      view.element.classList.toggle('node-selected', nodeId === this.selected);
    }
  }

  /**
   * Where in the history the view is, so the graph shows it: the node being
   * looked at is marked and everything treated as absent is dimmed.
   */
  setRolledBack(marker: NodeId | null, beyond: ReadonlySet<NodeId>): void {
    this.marker = marker;
    this.beyond = new Set(beyond);
    this.applyRollback();
  }

  private applyRollback(): void {
    for (const [nodeId, view] of this.views) {
      view.element.classList.toggle('node-marker', nodeId === this.marker);
      view.element.classList.toggle('node-beyond', this.beyond.has(nodeId));
    }
  }

  /** Which nodes the last solve actually drew, so the eye can show the truth. */
  setShown(visible: readonly NodeId[]): void {
    this.shownNodes = new Set(visible);
    for (const [nodeId, view] of this.views) {
      if (view.eye === null) continue;
      const shown = this.shownNodes.has(nodeId);
      view.eye.textContent = shown ? '◉' : '○';
      view.eye.classList.toggle('node-eye-off', !shown);
    }
  }

  setStatuses(reports: readonly NodeReport[]): void {
    const byNode = new Map<NodeId, NodeReport>();
    for (const report of reports) byNode.set(report.nodeId, report);

    for (const [nodeId, view] of this.views) {
      const report = byNode.get(nodeId);
      const status: NodeStatus | 'stale' = report?.status ?? 'stale';
      view.element.dataset.status = status;
      view.statusEl.textContent = status === 'error' ? 'error' : '';
      view.element.title = report?.error ?? '';
    }
  }

  /** Pan just enough to bring a node into view, keeping the current zoom. */
  reveal(nodeId: NodeId): void {
    const node = this.graph.getNode(nodeId);
    if (node === undefined) return;

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const schema = this.graph.schemaOf(nodeId);
    const left = this.pan.x + node.position.x * this.zoom;
    const top = this.pan.y + node.position.y * this.zoom;
    const right = left + NODE_WIDTH * this.zoom;
    const bottom = top + nodeHeight(schema) * this.zoom;
    const margin = 32;

    if (right > width - margin) this.pan.x -= right - (width - margin);
    else if (left < margin) this.pan.x += margin - left;

    if (bottom > height - margin) this.pan.y -= bottom - (height - margin);
    else if (top < margin) this.pan.y += margin - top;

    this.applyTransform();
  }

  frame(): void {
    const nodes = this.graph.allNodes();
    if (nodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      const schema = this.graph.schemaOf(node.id);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + NODE_WIDTH);
      maxY = Math.max(maxY, node.position.y + nodeHeight(schema));
    }

    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const margin = 40;
    const scale = Math.min(
      (width - margin * 2) / Math.max(maxX - minX, 1),
      (height - margin * 2) / Math.max(maxY - minY, 1),
    );

    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
    this.pan.x = (width - (maxX - minX) * this.zoom) / 2 - minX * this.zoom;
    this.pan.y = (height - (maxY - minY) * this.zoom) / 2 - minY * this.zoom;
    this.applyTransform();
  }
}
