import { Evaluator } from './core/evaluator.js';
import { Graph } from './core/graph.js';
import { NodeRegistry } from './core/registry.js';
import type { NodeId, Value } from './core/types.js';
import { isVec3 } from './core/types.js';
import { mathNodes } from './nodes/math.js';

const registry = new NodeRegistry();
registry.registerAll(mathNodes);

const graph = new Graph(registry);
const evaluator = new Evaluator(registry);

const width = graph.addNode('math.number', { label: 'Width', inputs: { value: 40 } });
const depth = graph.addNode('math.number', { label: 'Depth', inputs: { value: 25 } });
const height = graph.addNode('math.number', { label: 'Height', inputs: { value: 12 } });
const footprint = graph.addNode('math.multiply', { label: 'Footprint' });
const volume = graph.addNode('math.multiply', { label: 'Volume' });
const ribCount = graph.addNode('math.number', { label: 'Rib count', inputs: { value: 6 } });
const ribPositions = graph.addNode('math.series', { label: 'Rib positions', inputs: { step: 8 } });
const ribSpan = graph.addNode('math.sum', { label: 'Rib span' });

graph.connect({ node: width.id, port: 'result' }, { node: footprint.id, port: 'a' });
graph.connect({ node: depth.id, port: 'result' }, { node: footprint.id, port: 'b' });
graph.connect({ node: footprint.id, port: 'result' }, { node: volume.id, port: 'a' });
graph.connect({ node: height.id, port: 'result' }, { node: volume.id, port: 'b' });
graph.connect({ node: ribCount.id, port: 'result' }, { node: ribPositions.id, port: 'count' });
graph.connect({ node: ribPositions.id, port: 'result' }, { node: ribSpan.id, port: 'values' });

interface Slider {
  nodeId: NodeId;
  label: string;
  min: number;
  max: number;
  step: number;
}

const sliders: Slider[] = [
  { nodeId: width.id, label: 'Width', min: 5, max: 120, step: 1 },
  { nodeId: depth.id, label: 'Depth', min: 5, max: 120, step: 1 },
  { nodeId: height.id, label: 'Height', min: 1, max: 60, step: 1 },
  { nodeId: ribCount.id, label: 'Rib count', min: 0, max: 24, step: 1 },
];

function formatValue(value: Value): string {
  if (value === null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (Array.isArray(value)) {
    const shown = value.slice(0, 6).map(formatValue).join(', ');
    return value.length > 6 ? `[${shown}, … ${value.length} items]` : `[${shown}]`;
  }
  if (isVec3(value)) return `(${value.x}, ${value.y}, ${value.z})`;
  return String(value);
}

const controls = document.getElementById('controls')!;
const resultsBody = document.getElementById('results')!;
const statsEl = document.getElementById('stats')!;

for (const slider of sliders) {
  const wrapper = document.createElement('label');

  const row = document.createElement('div');
  row.className = 'label-row';
  const name = document.createElement('span');
  name.textContent = slider.label;
  const readout = document.createElement('span');
  readout.textContent = String(graph.inputValue(slider.nodeId, 'value'));
  row.append(name, readout);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(slider.min);
  input.max = String(slider.max);
  input.step = String(slider.step);
  input.value = String(graph.inputValue(slider.nodeId, 'value'));
  input.addEventListener('input', () => {
    const next = Number(input.value);
    readout.textContent = String(next);
    graph.setInput(slider.nodeId, 'value', next);
    render();
  });

  wrapper.append(row, input);
  controls.append(wrapper);
}

function render(): void {
  const solve = evaluator.evaluate(graph);
  resultsBody.replaceChildren();

  for (const nodeId of solve.order) {
    const node = graph.requireNode(nodeId);
    const definition = registry.require(node.type);
    const result = solve.results.get(nodeId);
    if (result === undefined) continue;

    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    nameCell.textContent = node.label ?? definition.label;

    const typeCell = document.createElement('td');
    typeCell.style.color = 'var(--muted)';
    typeCell.textContent = node.type;

    const statusCell = document.createElement('td');
    statusCell.className = `status ${result.status}`;
    statusCell.textContent = result.status;

    const outputCell = document.createElement('td');
    outputCell.textContent =
      result.error ??
      definition.outputs.map((port) => formatValue(result.outputs[port.id] ?? null)).join('  ');

    row.append(nameCell, typeCell, statusCell, outputCell);
    resultsBody.append(row);
  }

  statsEl.replaceChildren();
  const summary = document.createElement('span');
  summary.textContent = `${solve.stats.evaluated} evaluated · ${solve.stats.cached} cached · ${solve.stats.errored} errored · ${solve.stats.skipped} skipped — cache holds ${evaluator.cache.size} entries`;
  statsEl.append(summary);
}

render();
