import type { Value } from '../core/types.js';

export function asNumber(value: Value, portId: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Input "${portId}" expects a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function asPositive(value: Value, portId: string): number {
  const numeric = asNumber(value, portId);
  if (numeric <= 0) throw new Error(`Input "${portId}" must be greater than zero`);
  return numeric;
}

export function asList(value: Value, portId: string): Value[] {
  if (!Array.isArray(value)) {
    throw new Error(`Input "${portId}" expects a list, got ${JSON.stringify(value)}`);
  }
  return value;
}
