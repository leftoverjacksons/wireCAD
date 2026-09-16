import type { NodeDefinition, Value } from '../core/types.js';

function asNumber(value: Value, portId: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`Input "${portId}" expects a number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function asList(value: Value, portId: string): Value[] {
  if (!Array.isArray(value)) {
    throw new Error(`Input "${portId}" expects a list, got ${JSON.stringify(value)}`);
  }
  return value;
}

function binary(
  type: string,
  label: string,
  apply: (a: number, b: number) => number,
): NodeDefinition {
  return {
    type,
    label,
    category: 'Math',
    inputs: [
      { id: 'a', label: 'A', type: 'number', default: 0 },
      { id: 'b', label: 'B', type: 'number', default: 0 },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'number' }],
    evaluate(inputs) {
      return { result: apply(asNumber(inputs.a ?? null, 'a'), asNumber(inputs.b ?? null, 'b')) };
    },
  };
}

export const numberNode: NodeDefinition = {
  type: 'math.number',
  label: 'Number',
  category: 'Math',
  inputs: [{ id: 'value', label: 'Value', type: 'number', default: 0 }],
  outputs: [{ id: 'result', label: 'Result', type: 'number' }],
  evaluate(inputs) {
    return { result: asNumber(inputs.value ?? null, 'value') };
  },
};

export const addNode = binary('math.add', 'Add', (a, b) => a + b);
export const subtractNode = binary('math.subtract', 'Subtract', (a, b) => a - b);
export const multiplyNode = binary('math.multiply', 'Multiply', (a, b) => a * b);

export const divideNode: NodeDefinition = {
  type: 'math.divide',
  label: 'Divide',
  category: 'Math',
  inputs: [
    { id: 'a', label: 'A', type: 'number', default: 0 },
    { id: 'b', label: 'B', type: 'number', default: 1 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'number' }],
  evaluate(inputs) {
    const divisor = asNumber(inputs.b ?? null, 'b');
    if (divisor === 0) throw new Error('Division by zero');
    return { result: asNumber(inputs.a ?? null, 'a') / divisor };
  },
};

export const vectorNode: NodeDefinition = {
  type: 'math.vector',
  label: 'Vector',
  category: 'Math',
  inputs: [
    { id: 'x', label: 'X', type: 'number', default: 0 },
    { id: 'y', label: 'Y', type: 'number', default: 0 },
    { id: 'z', label: 'Z', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'result', label: 'Vector', type: 'vector' }],
  evaluate(inputs) {
    return {
      result: {
        x: asNumber(inputs.x ?? null, 'x'),
        y: asNumber(inputs.y ?? null, 'y'),
        z: asNumber(inputs.z ?? null, 'z'),
      },
    };
  },
};

export const seriesNode: NodeDefinition = {
  type: 'math.series',
  label: 'Series',
  category: 'Math',
  inputs: [
    { id: 'start', label: 'Start', type: 'number', default: 0 },
    { id: 'step', label: 'Step', type: 'number', default: 1 },
    { id: 'count', label: 'Count', type: 'number', default: 10 },
  ],
  outputs: [{ id: 'result', label: 'Series', type: 'list' }],
  evaluate(inputs) {
    const start = asNumber(inputs.start ?? null, 'start');
    const step = asNumber(inputs.step ?? null, 'step');
    const count = asNumber(inputs.count ?? null, 'count');
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Count must be a non-negative integer, got ${count}`);
    }
    return { result: Array.from({ length: count }, (_, i) => start + i * step) };
  },
};

export const sumNode: NodeDefinition = {
  type: 'math.sum',
  label: 'Sum',
  category: 'Math',
  inputs: [{ id: 'values', label: 'Values', type: 'list', default: [] }],
  outputs: [{ id: 'result', label: 'Result', type: 'number' }],
  evaluate(inputs) {
    const values = asList(inputs.values ?? null, 'values');
    let total = 0;
    for (const value of values) total += asNumber(value, 'values');
    return { result: total };
  },
};

export const mathNodes: readonly NodeDefinition[] = [
  numberNode,
  addNode,
  subtractNode,
  multiplyNode,
  divideNode,
  vectorNode,
  seriesNode,
  sumNode,
];
