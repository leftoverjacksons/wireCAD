import './styles.css';
import { Graph } from './core/graph.js';
import { NodeRegistry } from './core/registry.js';
import type { NodeId, NodeSchema } from './core/types.js';
import { mathNodes } from './nodes/math.js';
import { geometrySchemas } from './nodes/solid.js';
import { autoLayout } from './ui/layout.js';
import { NodeEditor } from './ui/node-editor.js';
import { Viewport } from './viewport.js';
import type { MainToWorker, WorkerToMain } from './worker/protocol.js';

const registry = new NodeRegistry<NodeSchema>();
registry.registerAll(mathNodes);
registry.registerAll(geometrySchemas);

const graph = new Graph(registry);

const width = graph.addNode('math.number', { label: 'Width', inputs: { value: 60 } });
const depth = graph.addNode('math.number', { label: 'Depth', inputs: { value: 40 } });
const height = graph.addNode('math.number', { label: 'Height', inputs: { value: 20 } });
const boreRadius = graph.addNode('math.number', { label: 'Bore radius', inputs: { value: 8 } });

const centreX = graph.addNode('math.divide', { label: 'Centre X', inputs: { b: 2 } });
const centreY = graph.addNode('math.divide', { label: 'Centre Y', inputs: { b: 2 } });
const boreDepth = graph.addNode('math.add', { label: 'Bore depth', inputs: { b: 4 } });

const bodyProfile = graph.addNode('sketch.rectangle', { label: 'Body profile' });
const body = graph.addNode('solid.extrude', { label: 'Body' });
const boreProfile = graph.addNode('sketch.circle', { label: 'Bore profile', inputs: { z: -2 } });
const bore = graph.addNode('solid.extrude', { label: 'Bore' });
const result = graph.addNode('solid.cut', { label: 'Result' });

graph.connect({ node: width.id, port: 'result' }, { node: bodyProfile.id, port: 'width' });
graph.connect({ node: depth.id, port: 'result' }, { node: bodyProfile.id, port: 'depth' });
graph.connect({ node: bodyProfile.id, port: 'profile' }, { node: body.id, port: 'profile' });
graph.connect({ node: height.id, port: 'result' }, { node: body.id, port: 'distance' });

graph.connect({ node: width.id, port: 'result' }, { node: centreX.id, port: 'a' });
graph.connect({ node: depth.id, port: 'result' }, { node: centreY.id, port: 'a' });
graph.connect({ node: centreX.id, port: 'result' }, { node: boreProfile.id, port: 'x' });
graph.connect({ node: centreY.id, port: 'result' }, { node: boreProfile.id, port: 'y' });
graph.connect({ node: boreRadius.id, port: 'result' }, { node: boreProfile.id, port: 'radius' });

graph.connect({ node: height.id, port: 'result' }, { node: boreDepth.id, port: 'a' });
graph.connect({ node: boreProfile.id, port: 'profile' }, { node: bore.id, port: 'profile' });
graph.connect({ node: boreDepth.id, port: 'result' }, { node: bore.id, port: 'distance' });

graph.connect({ node: body.id, port: 'solid' }, { node: result.id, port: 'base' });
graph.connect({ node: bore.id, port: 'solid' }, { node: result.id, port: 'tool' });

autoLayout(graph);

const viewport = new Viewport(document.getElementById('viewport')!);
const statsEl = document.getElementById('stats')!;
const statusEl = document.getElementById('kernel-status')!;
const controls = document.getElementById('controls')!;

const editor = new NodeEditor(document.getElementById('node-editor')!, graph, {
  onDocumentChanged: () => requestSolve(),
  onSelectionChanged: (nodeId) => viewport.setHighlight(nodeId),
});
editor.frame();

viewport.onPick((nodeId) => {
  editor.setSelection(nodeId);
  viewport.setHighlight(nodeId);
});

// ------------------------------------------------------------------ controls

const sliders: Array<{ nodeId: NodeId; label: string; min: number; max: number; step: number }> = [
  { nodeId: width.id, label: 'Width', min: 20, max: 160, step: 1 },
  { nodeId: depth.id, label: 'Depth', min: 20, max: 160, step: 1 },
  { nodeId: height.id, label: 'Height', min: 4, max: 80, step: 1 },
  { nodeId: boreRadius.id, label: 'Bore radius', min: 2, max: 40, step: 0.5 },
];

const sliderInputs = new Map<NodeId, { range: HTMLInputElement; readout: HTMLElement }>();

for (const slider of sliders) {
  const wrapper = document.createElement('label');
  wrapper.className = 'control';

  const row = document.createElement('div');
  row.className = 'label-row';
  const name = document.createElement('span');
  name.textContent = slider.label;
  const readout = document.createElement('span');
  readout.textContent = String(graph.inputValue(slider.nodeId, 'value'));
  row.append(name, readout);

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(slider.min);
  range.max = String(slider.max);
  range.step = String(slider.step);
  range.value = String(graph.inputValue(slider.nodeId, 'value'));
  range.addEventListener('input', () => {
    const next = Number(range.value);
    readout.textContent = String(next);
    graph.setInput(slider.nodeId, 'value', next);
    requestSolve();
  });

  wrapper.append(row, range);
  controls.append(wrapper);
  sliderInputs.set(slider.nodeId, { range, readout });
}

// Editing a value in the node editor must move the slider that shows it: both
// panels are views of one document, not separate copies of the number.
graph.subscribe((change) => {
  if (change.kind !== 'input-changed') return;
  const bound = sliderInputs.get(change.nodeId);
  if (bound === undefined || change.portId !== 'value') return;
  const value = String(graph.inputValue(change.nodeId, 'value'));
  bound.range.value = value;
  bound.readout.textContent = value;
});

// -------------------------------------------------------------------- solver

const worker = new Worker(new URL('./worker/geometry-worker.ts', import.meta.url), {
  type: 'module',
});

let requestId = 0;
let inFlight = false;
let dirty = false;

function requestSolve(): void {
  if (inFlight) {
    dirty = true;
    return;
  }
  inFlight = true;
  const message: MainToWorker = { type: 'solve', requestId: ++requestId, document: graph.toJSON() };
  worker.postMessage(message);
}

worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
  const message = event.data;

  if (message.type === 'ready') {
    statusEl.textContent = `kernel ready in ${(message.loadMs / 1000).toFixed(2)} s`;
    requestSolve();
    return;
  }

  if (message.type === 'failed') {
    statusEl.textContent = `solve failed: ${message.message}`;
    inFlight = false;
    return;
  }

  for (const mesh of message.meshes) viewport.setMesh(mesh);
  viewport.retain(message.visible);
  viewport.frameOnce();
  editor.setStatuses(message.reports);

  const errors = message.reports.filter((report) => report.error !== undefined);
  statsEl.textContent =
    `${message.stats.evaluated} evaluated · ${message.stats.cached} cached · ` +
    `${message.stats.errored} errored\nsolve ${message.solveMs.toFixed(1)} ms · ` +
    `mesh ${message.meshMs.toFixed(1)} ms · ${message.triangles} triangles` +
    (errors.length > 0 ? `\n${errors[0]!.error}` : '');

  inFlight = false;
  if (dirty) {
    dirty = false;
    requestSolve();
  }
};

// ------------------------------------------------------------------ splitter

const main = document.querySelector('main')!;
const splitter = document.getElementById('splitter')!;

splitter.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  splitter.setPointerCapture(event.pointerId);

  const onMove = (move: PointerEvent) => {
    const rect = main.getBoundingClientRect();
    const editorHeight = Math.min(Math.max(rect.bottom - move.clientY, 120), rect.height - 160);
    main.style.gridTemplateRows = `1fr 6px ${editorHeight}px`;
  };

  const onUp = () => {
    splitter.removeEventListener('pointermove', onMove);
    splitter.removeEventListener('pointerup', onUp);
  };

  splitter.addEventListener('pointermove', onMove);
  splitter.addEventListener('pointerup', onUp);
});

statusEl.textContent = 'loading OpenCASCADE kernel…';
