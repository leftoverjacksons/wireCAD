import type { Graph } from '../core/graph.js';
import type { NodeId, PortRef } from '../core/types.js';
import type { FeatureSpec } from './features.js';
import { buildFeature, candidatesFor, outputPortFor } from './features.js';

export interface FeatureDialogCallbacks {
  onBeforeChange(): void;
  onCommit(nodeId: NodeId): void;
  onArmedChanged(armed: boolean): void;
}

export class FeatureDialog {
  private readonly element: HTMLElement;
  private spec: FeatureSpec | null = null;
  private readonly chosen = new Map<string, NodeId>();
  private readonly numbers = new Map<string, number>();
  private readonly selects = new Map<string, HTMLSelectElement>();
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
    this.selects.clear();
    this.armedOperand = null;

    for (const number of spec.numbers) this.numbers.set(number.id, number.value);

    if (preselected !== null) {
      const first = spec.operands[0];
      if (first !== undefined && outputPortFor(this.graph, preselected, first.type) !== null) {
        this.chosen.set(first.id, preselected);
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

  /** Feed a selection from the viewport or node editor into the armed slot. */
  offerNode(nodeId: NodeId): boolean {
    const spec = this.spec;
    const armed = this.armedOperand;
    if (spec === null || armed === null) return false;

    const operand = spec.operands.find((candidate) => candidate.id === armed);
    if (operand === undefined) return false;
    if (outputPortFor(this.graph, nodeId, operand.type) === null) {
      this.setMessage(`That node has no ${operand.type} output`);
      return false;
    }

    this.chosen.set(armed, nodeId);
    const select = this.selects.get(armed);
    if (select !== undefined) select.value = nodeId;

    this.armedOperand = null;
    this.render();
    this.armNextEmpty();
    return true;
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

  private render(): void {
    const spec = this.spec;
    if (spec === null) return;

    this.element.hidden = false;
    this.element.replaceChildren();
    this.selects.clear();

    const title = document.createElement('div');
    title.className = 'feature-title';
    title.textContent = spec.label;
    this.element.append(title);

    for (const operand of spec.operands) {
      const row = document.createElement('div');
      row.className = 'feature-row';
      if (this.armedOperand === operand.id) row.classList.add('feature-row-armed');

      const label = document.createElement('span');
      label.className = 'feature-label';
      label.textContent = operand.optional === true ? `${operand.label} (opt)` : operand.label;

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

      select.value = this.chosen.get(operand.id) ?? '';
      select.addEventListener('change', () => {
        if (select.value === '') this.chosen.delete(operand.id);
        else this.chosen.set(operand.id, select.value);
        this.armedOperand = null;
        this.armNextEmpty();
      });

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'feature-pick';
      pick.textContent = this.armedOperand === operand.id ? 'picking…' : 'pick';
      pick.addEventListener('click', () => {
        this.armedOperand = this.armedOperand === operand.id ? null : operand.id;
        this.render();
        this.callbacks.onArmedChanged(this.armedOperand !== null);
      });

      this.selects.set(operand.id, select);
      row.append(label, select, pick);
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
        if (!Number.isNaN(parsed)) this.numbers.set(number.id, parsed);
      });

      row.append(label, field);
      this.element.append(row);
    }

    const message = document.createElement('div');
    message.className = 'feature-message';
    if (this.armedOperand !== null) {
      message.textContent = 'Click a body or sketch in the view, or a node below.';
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

  private commit(): void {
    const spec = this.spec;
    if (spec === null) return;

    const operands: Record<string, PortRef> = {};
    for (const operand of spec.operands) {
      const nodeId = this.chosen.get(operand.id);
      if (nodeId === undefined) {
        if (operand.optional === true) continue;
        this.setMessage(`${operand.label} is required`);
        return;
      }
      const port = outputPortFor(this.graph, nodeId, operand.type);
      if (port === null) {
        this.setMessage(`${operand.label} is not a ${operand.type}`);
        return;
      }
      operands[operand.id] = port;
    }

    const numbers: Record<string, number> = {};
    for (const number of spec.numbers) numbers[number.id] = this.numbers.get(number.id) ?? number.value;

    try {
      this.callbacks.onBeforeChange();
      const nodeId = buildFeature(this.graph, spec, operands, numbers);
      this.close();
      this.callbacks.onCommit(nodeId);
    } catch (thrown) {
      this.setMessage(thrown instanceof Error ? thrown.message : String(thrown));
    }
  }
}
