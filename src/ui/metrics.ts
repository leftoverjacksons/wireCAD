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

export function portRows(schema: NodeSchema): number {
  return Math.max(visibleInputs(schema).length, visibleOutputs(schema).length, 1);
}

export function nodeHeight(schema: NodeSchema): number {
  return HEADER_HEIGHT + portRows(schema) * ROW_HEIGHT + NODE_PADDING;
}

export function portCentreY(index: number): number {
  return HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

export function inputPortY(schema: NodeSchema, portId: string): number {
  const index = visibleInputs(schema).findIndex((port) => port.id === portId);
  return portCentreY(index < 0 ? 0 : index);
}

export function outputPortY(schema: NodeSchema, portId: string): number {
  const index = visibleOutputs(schema).findIndex((port) => port.id === portId);
  return portCentreY(index < 0 ? 0 : index);
}
