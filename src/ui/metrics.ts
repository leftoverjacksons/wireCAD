import type { NodeSchema, PortDef } from '../core/types.js';

export const NODE_WIDTH = 230;
export const HEADER_HEIGHT = 30;
export const ROW_HEIGHT = 24;
export const NODE_PADDING = 10;

export const COLUMN_GAP = 90;
export const ROW_GAP = 26;

/** Structural ports are stored and evaluated but take up no room on the node. */
export function visibleInputs(schema: NodeSchema): readonly PortDef[] {
  return schema.inputs.filter((port) => port.hidden !== true);
}

export function visibleOutputs(schema: NodeSchema): readonly PortDef[] {
  return schema.outputs.filter((port) => port.hidden !== true);
}

/**
 * Which row each port sits on.
 *
 * An output that echoes an input belongs beside it — Radius in on the left,
 * Radius out on the right — so echoes claim their input's row first and the
 * node's real outputs fill the rows left over, from the top. A row with nothing
 * on one side is left empty rather than closed up, because closing it up is what
 * puts a dimension next to the wrong label.
 */
export interface PortLayout {
  /** The input on each row, or undefined where that side is empty. */
  inputAt: ReadonlyArray<PortDef | undefined>;
  outputAt: ReadonlyArray<PortDef | undefined>;
  inputRow: ReadonlyMap<string, number>;
  outputRow: ReadonlyMap<string, number>;
  rows: number;
}

export function portLayout(schema: NodeSchema): PortLayout {
  const inputs = visibleInputs(schema);
  const outputs = visibleOutputs(schema);

  const inputRow = new Map<string, number>();
  inputs.forEach((port, row) => inputRow.set(port.id, row));

  const outputRow = new Map<string, number>();
  const claimed = new Set<number>();
  for (const port of outputs) {
    if (port.echoes === undefined) continue;
    const row = inputRow.get(port.echoes);
    if (row === undefined) continue;
    outputRow.set(port.id, row);
    claimed.add(row);
  }

  let next = 0;
  for (const port of outputs) {
    if (outputRow.has(port.id)) continue;
    while (claimed.has(next)) next += 1;
    outputRow.set(port.id, next);
    claimed.add(next);
    next += 1;
  }

  const lastOutput = outputRow.size === 0 ? -1 : Math.max(...outputRow.values());
  const rows = Math.max(inputs.length, lastOutput + 1, 1);

  const inputAt: Array<PortDef | undefined> = new Array(rows).fill(undefined);
  for (const port of inputs) inputAt[inputRow.get(port.id)!] = port;

  const outputAt: Array<PortDef | undefined> = new Array(rows).fill(undefined);
  for (const port of outputs) outputAt[outputRow.get(port.id)!] = port;

  return { inputAt, outputAt, inputRow, outputRow, rows };
}

export function portRows(schema: NodeSchema): number {
  return portLayout(schema).rows;
}

export function nodeHeight(schema: NodeSchema): number {
  return HEADER_HEIGHT + portRows(schema) * ROW_HEIGHT + NODE_PADDING;
}

export function portCentreY(index: number): number {
  return HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function inputPortY(schema: NodeSchema, portId: string): number {
  return portCentreY(portLayout(schema).inputRow.get(portId) ?? 0);
}

export function outputPortY(schema: NodeSchema, portId: string): number {
  return portCentreY(portLayout(schema).outputRow.get(portId) ?? 0);
}
