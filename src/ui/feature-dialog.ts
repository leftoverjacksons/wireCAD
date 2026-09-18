import type { Graph } from '../core/graph.js';
import { removeAndHeal } from '../core/rewire.js';
import type { NodeId, PortRef, Vec3 } from '../core/types.js';
import type { FeatureSpec, OperandSpec, PlaneChoice } from './features.js';
import type { EdgeRef } from '../nodes/edges.js';
import { packEdgeRefs } from '../nodes/edges.js';
import {
  buildFeature,
  candidatesFor,
  outputPortFor,
  resolveEdgeSource,
  resolvePlaneSource,
} from './features.js';

export interface FeatureDialogCallbacks {
  onBeforeChange(): void;
  /** The last capture is no longer wanted: a preview was taken back out again. */
  onForget(): void;
  onCommit(nodeId: NodeId): void;
  onArmedChanged(armed: boolean): void;
  /** The preview node, or null when there is nothing to show yet. */
  onPreviewChanged(nodeId: NodeId | null): void;
  /** A sketch feature hands its plane off to interactive drawing. */
  onSketch(choice: PlaneChoice): void;
}

export interface PickedFace {
  normal: Vec3;
  rank: number;
}

export interface PickedEdge {
  index: number;
  ref: EdgeRef;
}

/**
 * Edges accumulate instead of replacing, and they all have to come off one body,
 * because the references are resolved against whatever solid the feature is fed.
 */
interface EdgeChoice {
  nodeId: NodeId;
  picks: Map<number, EdgeRef>;
}

type OperandChoice = PlaneChoice;

export class FeatureDialog {
  private readonly element: HTMLElement;
  private spec: FeatureSpec | null = null;
  private readonly chosen = new Map<string, OperandChoice>();
  private readonly numbers = new Map<string, number>();
  private readonly choices = new Map<string, string>();
  private armedOperand: string | null = null;
  private message: HTMLElement | null = null;
  private edges: EdgeChoice | null = null;
  private edgeListener: ((choice: EdgeChoice | null) => void) | null = null;
  /** What the feature currently looks like, standing in the graph already. */
  private preview: { nodeId: NodeId; created: NodeId[] } | null = null;
  /** Whether the history snapshot taken before the first preview still stands. */
  private captured = false;
  private failure: string | null = null;
  /** The operand set the preview was built from; numbers change without a rebuild. */
  private previewSignature: string | null = null;
  private readonly numberFields = new Map<string, HTMLInputElement>();

  constructor(
    container: HTMLElement,
    private readonly graph: Graph,
    private readonly callbacks: FeatureDialogCallbacks,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'feature-dialog';
    this.element.hidden = true;
    container.append(this.element);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
    });
  }

  get isOpen(): boolean {
    return this.spec !== null;
  }

  get isArmed(): boolean {
    return this.armedOperand !== null;
  }

  /** True while the armed slot wants edges rather than a body or a face. */
  get isPickingEdges(): boolean {
    const spec = this.spec;
    if (spec === null || this.armedOperand === null) return false;
    return spec.operands.find((o) => o.id === this.armedOperand)?.type === 'edges';
  }

  onEdgesChanged(listener: (choice: EdgeChoice | null) => void): void {
    this.edgeListener = listener;
  }

  open(spec: FeatureSpec, preselected: NodeId | null): void {
    // Whatever was open is abandoned, preview and all.
    if (this.spec !== null) this.close();

    this.spec = spec;
    this.chosen.clear();
    this.numbers.clear();
    this.choices.clear();
    this.armedOperand = null;
    this.edges = null;
    this.edgeListener?.(null);

    for (const number of spec.numbers) this.numbers.set(number.id, number.value);
    for (const choice of spec.choices ?? []) this.choices.set(choice.id, choice.value);

    if (preselected !== null) {
      // A prior selection is a node, which cannot stand in for a picked face.
      const first = spec.operands[0];
      if (
        first !== undefined &&
        first.type !== 'face' &&
        outputPortFor(this.graph, preselected, first.type) !== null
      ) {
        this.chosen.set(first.id, { kind: 'node', nodeId: preselected });
      }
    }

    this.render();
    this.armNextEmpty();
    this.refreshPreview();
  }

  /** Leaving without creating: the preview goes back out of the graph. */
  close(): void {
    this.dropPreview();
    if (this.captured) {
      this.callbacks.onForget();
      this.captured = false;
    }
    this.finish();
  }

  private finish(): void {
    this.spec = null;
    this.armedOperand = null;
    this.edges = null;
    this.preview = null;
    this.previewSignature = null;
    this.captured = false;
    this.failure = null;
    this.numberFields.clear();
    this.edgeListener?.(null);
    this.element.hidden = true;
    this.element.replaceChildren();
    this.callbacks.onArmedChanged(false);
    this.callbacks.onPreviewChanged(null);
  }

  // ------------------------------------------------------------- preview

  /** The feature as it currently stands, already in the graph. */
  get previewNodeId(): NodeId | null {
    return this.preview?.nodeId ?? null;
  }

  get feature(): FeatureSpec | null {
    return this.spec;
  }

  /** Which node is feeding an operand, for whoever needs to know where it is. */
  operandNode(portId: string): NodeId | null {
    return this.chosen.get(portId)?.nodeId ?? null;
  }

  /** The face picked for an operand, when one was picked rather than a node. */
  operandFace(portId: string): PickedFace | null {
    const choice = this.chosen.get(portId);
    return choice === undefined || choice.kind !== 'face'
      ? null
      : { normal: choice.normal, rank: choice.rank };
  }

  numberOf(id: string): number | null {
    return this.numbers.get(id) ?? null;
  }

  /** Set a number from outside, such as a handle dragged in the view. */
  setNumber(id: string, value: number): void {
    if (this.spec === null) return;
    if (this.numbers.get(id) === value) return;

    this.numbers.set(id, value);
    const field = this.numberFields.get(id);
    if (field !== undefined) field.value = String(value);
    this.refreshPreview();
  }

  /** Nodes the preview put in the graph, which are not operands to choose from. */
  private previewNodes(): Set<NodeId> {
    return new Set(this.preview === null ? [] : [this.preview.nodeId, ...this.preview.created]);
  }

  private dropPreview(): void {
    const preview = this.preview;
    this.preview = null;
    this.previewSignature = null;
    if (preview === null) return;

    // A feature that spliced itself into the chain took the operand's consumers
    // with it, so taking it back out has to hand them back — which is exactly
    // what healing is. For everything else, which was appended and so has no
    // consumers of its own, healing is a plain removal.
    if ((this.graph.getNode(preview.nodeId) ?? null) !== null) {
      removeAndHeal(this.graph, preview.nodeId);
    }
    for (const nodeId of preview.created) {
      if ((this.graph.getNode(nodeId) ?? null) !== null) this.graph.removeNode(nodeId);
    }
    this.callbacks.onPreviewChanged(null);
  }

  /** What the operands add up to. A change here needs the nodes built again. */
  private operandSignature(): string {
    const spec = this.spec;
    if (spec === null) return '';

    const parts: string[] = [spec.id];
    for (const operand of spec.operands) {
      const choice = this.chosen.get(operand.id);
      if (choice === undefined) parts.push(`${operand.id}=`);
      else if (choice.kind === 'face') {
        const { x, y, z } = choice.normal;
        parts.push(`${operand.id}=face:${choice.nodeId}:${choice.rank}:${x},${y},${z}`);
      } else parts.push(`${operand.id}=node:${choice.nodeId}`);
    }
    if (this.edges !== null) {
      parts.push(`edges=${this.edges.nodeId}:${[...this.edges.picks.keys()].sort().join('.')}`);
    }
    return parts.join('|');
  }

  /**
   * Builds, or updates, the feature as it currently stands.
   *
   * The preview is the real thing, standing in the graph already: the same
   * nodes, evaluated by the same worker, drawn by the same viewport. Create
   * keeps it and Cancel takes it back out. Nothing else could be relied on to
   * show what pressing Create would actually do.
   */
  private refreshPreview(): void {
    const spec = this.spec;
    if (spec === null || spec.kind === 'sketch' || spec.kind === 'edit') return;

    const ready = spec.operands.every(
      (operand) => operand.optional === true || this.chosen.has(operand.id),
    );
    if (!ready) {
      this.dropPreview();
      return;
    }

    // Only the numbers moved: the nodes are right, so leave them where they are
    // and set the values. Rebuilding on every keystroke would renumber and
    // re-lay-out the graph under the cursor.
    const signature = this.operandSignature();
    if (this.preview !== null && signature === this.previewSignature) {
      for (const [id, value] of this.inputValues()) {
        this.graph.setInput(this.preview.nodeId, id, value);
      }
      this.callbacks.onPreviewChanged(this.preview.nodeId);
      return;
    }

    this.dropPreview();
    if (!this.captured) {
      this.callbacks.onBeforeChange();
      this.captured = true;
    }

    try {
      this.preview = this.buildNodes();
      this.previewSignature = signature;
      this.failure = null;
    } catch (thrown) {
      this.failure = thrown instanceof Error ? thrown.message : String(thrown);
      this.setMessage(this.failure);
    }

    this.callbacks.onPreviewChanged(this.preview?.nodeId ?? null);
  }

  private inputValues(): Array<[string, number | string]> {
    const spec = this.spec;
    if (spec === null) return [];

    const values: Array<[string, number | string]> = [];
    for (const number of spec.numbers) values.push([number.id, this.numbers.get(number.id) ?? number.value]);
    for (const choice of spec.choices ?? []) {
      values.push([choice.id, this.choices.get(choice.id) ?? choice.value]);
    }
    return values;
  }

  /**
   * Feed a viewport or graph selection into the armed slot. A planar face
   * standing in for a plane becomes a face reference; anything else is taken as
   * the node itself.
   */
  offerPick(nodeId: NodeId, face: PickedFace | null): boolean {
    const spec = this.spec;
    const armed = this.armedOperand;
    if (spec === null || armed === null) return false;

    // The preview is this feature's own output; feeding it back in would be a
    // cycle, and clicking it is what happens when it covers what you meant.
    if (this.previewNodes().has(nodeId)) {
      this.setMessage('That is this feature\u2019s own preview');
      return false;
    }

    const operand = spec.operands.find((candidate) => candidate.id === armed);
    if (operand === undefined) return false;

    if (operand.type === 'face') {
      if (face === null) {
        this.setMessage('Click a flat face of a solid');
        return false;
      }
      if (outputPortFor(this.graph, nodeId, 'geometry') === null) {
        this.setMessage('That face is not on a solid');
        return false;
      }
      this.chosen.set(armed, { kind: 'face', nodeId, normal: face.normal, rank: face.rank });
      this.advance();
      return true;
    }

    if (operand.type === 'plane' && face !== null) {
      this.chosen.set(armed, { kind: 'face', nodeId, normal: face.normal, rank: face.rank });
      this.advance();
      return true;
    }

    if (outputPortFor(this.graph, nodeId, operand.type) === null) {
      this.setMessage(
        operand.type === 'plane'
          ? 'Pick a flat face, or a plane node'
          : `That node has no ${operand.type} output`,
      );
      return false;
    }

    this.chosen.set(armed, { kind: 'node', nodeId });
    this.advance();
    return true;
  }

  /** Clicking an edge adds it; clicking it again takes it back out. */
  offerEdge(nodeId: NodeId, edge: PickedEdge): boolean {
    const spec = this.spec;
    const armed = this.armedOperand;
    if (spec === null || armed === null) return false;
    if (spec.operands.find((candidate) => candidate.id === armed)?.type !== 'edges') return false;
    if (this.previewNodes().has(nodeId)) {
      this.setMessage('That is this feature\u2019s own preview');
      return false;
    }

    if (outputPortFor(this.graph, nodeId, 'geometry') === null) {
      this.setMessage('That edge is not on a solid');
      return false;
    }

    if (this.edges !== null && this.edges.nodeId !== nodeId) {
      this.setMessage('All the edges have to be on one body');
      return false;
    }

    const choice = this.edges ?? { nodeId, picks: new Map<number, EdgeRef>() };
    if (choice.picks.has(edge.index)) choice.picks.delete(edge.index);
    else choice.picks.set(edge.index, edge.ref);

    this.edges = choice.picks.size === 0 ? null : choice;
    if (this.edges === null) this.chosen.delete(armed);
    else this.chosen.set(armed, { kind: 'node', nodeId });

    this.edgeListener?.(this.edges);
    // Stay armed: picking edges is a set, not a single answer.
    this.render();
    this.refreshPreview();
    return true;
  }

  private advance(): void {
    this.armedOperand = null;
    this.render();
    this.armNextEmpty();
    this.refreshPreview();
  }

  private armNextEmpty(): void {
    const spec = this.spec;
    if (spec === null) return;
    const next = spec.operands.find((operand) => !this.chosen.has(operand.id));
    this.armedOperand = next?.id ?? null;
    this.render();
    this.callbacks.onArmedChanged(this.armedOperand !== null);
  }

  private setMessage(text: string): void {
    if (this.message !== null) this.message.textContent = text;
  }

  private describeNode(nodeId: NodeId): string {
    const node = this.graph.getNode(nodeId);
    return node === undefined || node === null
      ? nodeId
      : (node.label ?? this.graph.registry.require(node.type).label);
  }

  private describe(choice: OperandChoice): string {
    const label = this.describeNode(choice.nodeId);
    return choice.kind === 'face' ? `Face of ${label} (rank ${choice.rank})` : label;
  }

  private renderOperand(operand: OperandSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'feature-row';
    if (this.armedOperand === operand.id) row.classList.add('feature-row-armed');

    const label = document.createElement('span');
    label.className = 'feature-label';
    label.textContent = operand.optional === true ? `${operand.label} (opt)` : operand.label;
    row.append(label);

    const choice = this.chosen.get(operand.id);

    if (operand.type === 'edges') {
      const chip = document.createElement('span');
      chip.className = 'feature-chip';
      const count = this.edges?.picks.size ?? 0;
      chip.textContent =
        count === 0 ? 'none picked' : `${count} edge${count === 1 ? '' : 's'} of ${this.describeNode(this.edges!.nodeId)}`;
      if (count === 0) chip.classList.add('feature-chip-empty');
      row.append(chip);

      if (count > 0) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'feature-pick';
        clear.textContent = 'clear';
        clear.addEventListener('click', () => {
          this.edges = null;
          this.chosen.delete(operand.id);
          this.edgeListener?.(null);
          this.render();
          this.refreshPreview();
        });
        row.append(clear);
      }
      return row;
    }

    if (choice?.kind === 'face' || operand.type === 'face') {
      const chip = document.createElement('span');
      chip.className = 'feature-chip';
      // A face can only come from clicking one, so there is no list to offer.
      chip.textContent = choice === undefined ? 'none picked' : this.describe(choice);
      if (choice === undefined) chip.classList.add('feature-chip-empty');
      row.append(chip);
    } else {
      const select = document.createElement('select');
      select.className = 'feature-select';

      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '—';
      select.append(empty);

      for (const candidate of candidatesFor(this.graph, operand.type, this.previewNodes())) {
        const option = document.createElement('option');
        option.value = candidate.nodeId;
        option.textContent = candidate.label;
        select.append(option);
      }

      select.value = choice?.nodeId ?? '';
      select.addEventListener('change', () => {
        if (select.value === '') this.chosen.delete(operand.id);
        else this.chosen.set(operand.id, { kind: 'node', nodeId: select.value });
        this.advance();
      });
      row.append(select);
    }

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'feature-pick';
    pick.textContent = this.armedOperand === operand.id ? 'picking…' : 'pick';
    pick.addEventListener('click', () => {
      if (this.armedOperand === operand.id) {
        this.armedOperand = null;
      } else {
        this.chosen.delete(operand.id);
        this.armedOperand = operand.id;
      }
      this.render();
      this.callbacks.onArmedChanged(this.armedOperand !== null);
    });
    row.append(pick);

    return row;
  }

  private render(): void {
    const spec = this.spec;
    if (spec === null) return;

    this.element.hidden = false;
    this.element.replaceChildren();
    this.numberFields.clear();

    const title = document.createElement('div');
    title.className = 'feature-title';
    title.textContent = spec.label;
    this.element.append(title);

    for (const operand of spec.operands) this.element.append(this.renderOperand(operand));

    for (const choice of spec.choices ?? []) {
      const row = document.createElement('div');
      row.className = 'feature-row';

      const label = document.createElement('span');
      label.className = 'feature-label';
      label.textContent = choice.label;

      const select = document.createElement('select');
      select.className = 'feature-select';
      for (const option of choice.options) {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = option;
        select.append(item);
      }
      select.value = this.choices.get(choice.id) ?? choice.value;
      select.addEventListener('change', () => {
        this.choices.set(choice.id, select.value);
        this.refreshPreview();
      });

      row.append(label, select);
      this.element.append(row);
    }

    for (const number of spec.numbers) {
      const row = document.createElement('div');
      row.className = 'feature-row';

      const label = document.createElement('span');
      label.className = 'feature-label';
      label.textContent = number.label;

      const field = document.createElement('input');
      field.type = 'number';
      field.className = 'feature-number';
      field.value = String(this.numbers.get(number.id) ?? number.value);
      field.addEventListener('input', () => {
        const parsed = Number(field.value);
        if (Number.isNaN(parsed)) return;
        this.numbers.set(number.id, parsed);
        this.refreshPreview();
      });
      this.numberFields.set(number.id, field);

      row.append(label, field);
      this.element.append(row);
    }

    const message = document.createElement('div');
    message.className = 'feature-message';
    if (this.armedOperand !== null) {
      const operand = spec.operands.find((candidate) => candidate.id === this.armedOperand);
      if (operand?.type === 'edges') {
        message.textContent = 'Click edges in the view. Click one again to drop it.';
      } else if (operand?.type === 'face') {
        message.textContent = 'Click the face to leave open.';
      } else if (operand?.type === 'plane') {
        message.textContent = 'Click a flat face in the view, or a plane node below.';
      } else {
        message.textContent = 'Click a body or sketch in the view, or a node below.';
      }
    }
    this.message = message;
    this.element.append(message);

    const actions = document.createElement('div');
    actions.className = 'feature-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tool-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.close());

    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'tool-button tool-primary';
    create.textContent = 'Create';
    create.addEventListener('click', () => this.commit());

    actions.append(cancel, create);
    this.element.append(actions);
  }

  /** Face references become a face.plane node, which is why they stay editable. */
  private resolveChoice(
    choice: OperandChoice,
    operand: OperandSpec,
    created: NodeId[],
  ): PortRef {
    if (choice.kind === 'node') {
      if (operand.type === 'face') throw new Error(`${operand.label} must be a picked face`);
      const port = outputPortFor(this.graph, choice.nodeId, operand.type);
      if (port === null) throw new Error(`${operand.label} is not a ${operand.type}`);
      return port;
    }
    return resolvePlaneSource(this.graph, choice, created);
  }

  /**
   * Puts the feature in the graph: the node itself, plus whatever it needs
   * alongside it — a node holding a set of picked edges, or one holding a face
   * reference. Anything created is rolled back if a later step fails.
   */
  private buildNodes(): { nodeId: NodeId; created: NodeId[] } {
    const spec = this.spec;
    if (spec === null) throw new Error('Nothing to build');

    const created: NodeId[] = [];

    try {
      const numbers: Record<string, number | string> = Object.fromEntries(this.inputValues());

      const operands: Record<string, PortRef> = {};
      for (const operand of spec.operands) {
        const choice = this.chosen.get(operand.id);
        if (choice === undefined) continue;

        // Picked edges wire the body they sit on, plus a node holding the set.
        if (operand.type === 'edges') {
          const picked = this.edges;
          if (picked === null || picked.picks.size === 0) {
            throw new Error(`${operand.label}: pick at least one edge`);
          }
          const source = outputPortFor(this.graph, picked.nodeId, 'geometry');
          if (source === null) throw new Error(`${operand.label} is not on a solid`);

          operands[operand.id] = source;
          operands.edges = resolveEdgeSource(
            this.graph,
            packEdgeRefs([...picked.picks.values()]),
            created,
          );
          continue;
        }

        // A picked face wires the body it belongs to and writes its own selector.
        if (operand.type === 'face') {
          if (choice.kind !== 'face') throw new Error(`${operand.label} must be a picked face`);
          const source = outputPortFor(this.graph, choice.nodeId, 'geometry');
          if (source === null) throw new Error(`${operand.label} is not on a solid`);

          operands[operand.id] = source;
          numbers.nx = choice.normal.x;
          numbers.ny = choice.normal.y;
          numbers.nz = choice.normal.z;
          numbers.rank = choice.rank;
          continue;
        }

        operands[operand.id] = this.resolveChoice(choice, operand, created);
      }

      return { nodeId: buildFeature(this.graph, spec, operands, numbers), created };
    } catch (thrown) {
      for (const nodeId of created.reverse()) this.graph.removeNode(nodeId);
      throw thrown;
    }
  }

  private commit(): void {
    const spec = this.spec;
    if (spec === null) return;

    for (const operand of spec.operands) {
      if (this.chosen.has(operand.id) || operand.optional === true) continue;
      this.setMessage(`${operand.label} is required`);
      return;
    }

    // A sketch feature creates nothing yet: drawing decides what gets built.
    if (spec.kind === 'sketch') {
      const choice = this.chosen.get(spec.operands[0]?.id ?? '');
      if (choice === undefined) {
        this.setMessage('Pick a plane or a flat face');
        return;
      }
      this.close();
      this.callbacks.onSketch(choice);
      return;
    }

    // Create keeps what is already on screen. The preview was built the same
    // way this used to build on Create, so there is nothing left to do but
    // stop calling it a preview.
    this.refreshPreview();
    const preview = this.preview;
    if (preview === null) {
      this.setMessage(this.failure ?? 'There is nothing to create yet');
      return;
    }

    const nodeId = preview.nodeId;
    this.preview = null;
    this.captured = false;
    this.finish();
    this.callbacks.onCommit(nodeId);
  }
}
