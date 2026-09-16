import type { Graph } from '../core/graph.js';
import type { NodeId, PortRef, Vec3 } from '../core/types.js';
import type { FeatureSpec, OperandSpec } from './features.js';
import { buildFeature, candidatesFor, outputPortFor, placeDownstream } from './features.js';

export interface FeatureDialogCallbacks {
  onBeforeChange(): void;
  onCommit(nodeId: NodeId): void;
  onArmedChanged(armed: boolean): void;
}

export interface PickedFace {
  normal: Vec3;
  rank: number;
}

type OperandChoice =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'face'; nodeId: NodeId; normal: Vec3; rank: number };

export class FeatureDialog {
  private readonly element: HTMLElement;
  private spec: FeatureSpec | null = null;
  private readonly chosen = new Map<string, OperandChoice>();
  private readonly numbers = new Map<string, number>();
  private armedOperand: string | null = null;
  private message: HTMLElement | null = null;

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

  open(spec: FeatureSpec, preselected: NodeId | null): void {
    this.spec = spec;
    this.chosen.clear();
    this.numbers.clear();
    this.armedOperand = null;

    for (const number of spec.numbers) this.numbers.set(number.id, number.value);

    if (preselected !== null) {
      const first = spec.operands[0];
      if (first !== undefined && outputPortFor(this.graph, preselected, first.type) !== null) {
        this.chosen.set(first.id, { kind: 'node', nodeId: preselected });
      }
    }

    this.render();
    this.armNextEmpty();
  }

  close(): void {
    this.spec = null;
    this.armedOperand = null;
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

  private describe(choice: OperandChoice): string {
    const node = this.graph.getNode(choice.nodeId);
    const label =
      node === undefined
        ? choice.nodeId
        : (node.label ?? this.graph.registry.require(node.type).label);
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

    if (choice?.kind === 'face') {
      const chip = document.createElement('span');
      chip.className = 'feature-chip';
      chip.textContent = this.describe(choice);
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
      message.textContent =
        operand?.type === 'plane'
          ? 'Click a flat face in the view, or a plane node below.'
          : 'Click a body or sketch in the view, or a node below.';
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
      const port = outputPortFor(this.graph, choice.nodeId, operand.type);
      if (port === null) throw new Error(`${operand.label} is not a ${operand.type}`);
      return port;
    }

    const source = outputPortFor(this.graph, choice.nodeId, 'geometry');
    if (source === null) throw new Error(`${operand.label} is not a solid`);

    const node = this.graph.addNode('face.plane', {
      inputs: {
        nx: choice.normal.x,
        ny: choice.normal.y,
        nz: choice.normal.z,
        rank: choice.rank,
      },
    });
    created.push(node.id);
    this.graph.connect(source, { node: node.id, port: 'solid' });
    placeDownstream(this.graph, node.id);

    return { node: node.id, port: 'plane' };
  }

  private commit(): void {
    const spec = this.spec;
    if (spec === null) return;

    for (const operand of spec.operands) {
      if (this.chosen.has(operand.id) || operand.optional === true) continue;
      this.setMessage(`${operand.label} is required`);
      return;
    }

    this.callbacks.onBeforeChange();
    const created: NodeId[] = [];

    try {
      const operands: Record<string, PortRef> = {};
      for (const operand of spec.operands) {
        const choice = this.chosen.get(operand.id);
        if (choice === undefined) continue;
        operands[operand.id] = this.resolveChoice(choice, operand, created);
      }

      const numbers: Record<string, number> = {};
      for (const number of spec.numbers) {
        numbers[number.id] = this.numbers.get(number.id) ?? number.value;
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
