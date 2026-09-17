import type { Graph } from '../core/graph.js';
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
  onCommit(nodeId: NodeId): void;
  onArmedChanged(armed: boolean): void;
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
  private armedOperand: string | null = null;
  private message: HTMLElement | null = null;
  private edges: EdgeChoice | null = null;
  private edgeListener: ((choice: EdgeChoice | null) => void) | null = null;

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
    this.spec = spec;
    this.chosen.clear();
    this.numbers.clear();
    this.armedOperand = null;
    this.edges = null;
    this.edgeListener?.(null);

    for (const number of spec.numbers) this.numbers.set(number.id, number.value);

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
  }

  close(): void {
    this.spec = null;
    this.armedOperand = null;
    this.edges = null;
    this.edgeListener?.(null);
    this.element.hidden = true;
    this.element.replaceChildren();
    this.callbacks.onArmedChanged(false);
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
    return true;
  }

  private advance(): void {
    this.armedOperand = null;
    this.render();
    this.armNextEmpty();
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

      for (const candidate of candidatesFor(this.graph, operand.type)) {
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

    const title = document.createElement('div');
    title.className = 'feature-title';
    title.textContent = spec.label;
    this.element.append(title);

    for (const operand of spec.operands) this.element.append(this.renderOperand(operand));

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
        if (!Number.isNaN(parsed)) this.numbers.set(number.id, parsed);
      });

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

    this.callbacks.onBeforeChange();
    const created: NodeId[] = [];

    try {
      const numbers: Record<string, number> = {};
      for (const number of spec.numbers) {
        numbers[number.id] = this.numbers.get(number.id) ?? number.value;
      }

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

      const nodeId = buildFeature(this.graph, spec, operands, numbers);
      this.close();
      this.callbacks.onCommit(nodeId);
    } catch (thrown) {
      for (const nodeId of created.reverse()) this.graph.removeNode(nodeId);
      this.setMessage(thrown instanceof Error ? thrown.message : String(thrown));
    }
  }
}
