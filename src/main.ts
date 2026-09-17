import './styles.css';
import { documentToText, parseDocument } from './core/document.js';
import { Graph } from './core/graph.js';
import { History } from './core/history.js';
import { NodeRegistry } from './core/registry.js';
import type { GraphNode, NodeId, NodeSchema, PlaneValue, Vec3 } from './core/types.js';
import { WORLD_XY, makePlane, pointOnPlane } from './geometry/plane.js';
import { faceSchemas, matchingFaces } from './nodes/face.js';
import { mathNodes } from './nodes/math.js';
import { constrainedSchemas } from './nodes/constrained.js';
import { edgeSchemas } from './nodes/edges.js';
import { modifySchemas } from './nodes/modify.js';
import { planeNodes } from './nodes/plane.js';
import { geometrySchemas } from './nodes/solid.js';
import { FeatureDialog } from './ui/feature-dialog.js';
import type { PickedFace } from './ui/feature-dialog.js';
import type { PlaneChoice } from './ui/features.js';
import { createSketchNode, tabs } from './ui/features.js';
import {
  download,
  keepRejected,
  pickFile,
  readAutosave,
  readRejected,
  timestampedName,
  writeAutosave,
} from './ui/file-io.js';
import { NodeEditor } from './ui/node-editor.js';
import { SketchSession } from './ui/sketch-session.js';
import { buildStarterModel } from './ui/starter.js';
import { Toolbar } from './ui/toolbar.js';
import type { FaceHit } from './viewport.js';
import { Viewport } from './viewport.js';
import type {
  ExportFormat,
  MainToWorker,
  MeshPayload,
  NodeReport,
  WorkerToMain,
} from './worker/protocol.js';

const registry = new NodeRegistry<NodeSchema>();
registry.registerAll(mathNodes);
registry.registerAll(planeNodes);
registry.registerAll(geometrySchemas);
registry.registerAll(faceSchemas);
registry.registerAll(modifySchemas);
registry.registerAll(edgeSchemas);
registry.registerAll(constrainedSchemas);

const graph = new Graph(registry);

// Prefer whatever the last session left behind over the starter model.
const autosaved = readAutosave();
let restoredFromAutosave = false;
/** Why the last session would not reopen, if it would not. */
let autosaveProblem: string | null = null;

if (autosaved !== null) {
  try {
    graph.restore(parseDocument(autosaved));
    restoredFromAutosave = true;
  } catch (thrown) {
    // Say why, and keep the document: the next autosave is moments away and
    // would otherwise write over the only copy of somebody's session.
    autosaveProblem = thrown instanceof Error ? thrown.message : String(thrown);
    keepRejected(autosaved);
  }
}
if (!restoredFromAutosave) buildStarterModel(graph);

const viewportEl = document.getElementById('viewport')!;
const viewport = new Viewport(viewportEl);
const statsEl = document.getElementById('stats')!;
const statusEl = document.getElementById('kernel-status')!;
const controls = document.getElementById('controls')!;

let selected: NodeId | null = null;
const history = new History(graph);

const editor = new NodeEditor(document.getElementById('node-editor')!, graph, {
  onBeforeChange: () => history.capture(),
  onDocumentChanged: () => requestSolve(),
  // The editor already holds this selection; only the viewport needs telling.
  onSelectionChanged: (nodeId) => applySelection(nodeId, false),
});
editor.frame();

let lastPlanes: Record<NodeId, PlaneValue> = {};
/**
 * The middle of everything that has been meshed, kept even after a body stops
 * being drawn. A profile is hidden the moment something extrudes it, and that
 * is exactly when a handle needs to know where it was.
 */
const lastCentres = new Map<NodeId, Vec3>();
let lastReports: NodeReport[] = [];
/**
 * The mesh each visible node currently has. The worker only sends a mesh when
 * it changes, so holding them here is what lets anything ask what is on screen
 * rather than what happened to arrive in the last message.
 */
const lastMeshes = new Map<NodeId, MeshPayload>();
let solveCount = 0;
let lastVisible: NodeId[] = [];

/** Resolve a plane choice to the plane the graph will actually produce for it. */
function planeValueFor(choice: PlaneChoice): PlaneValue | null {
  if (choice.kind === 'node') return lastPlanes[choice.nodeId] ?? null;

  const faces = viewport.facesOf(choice.nodeId);
  if (faces === undefined) return null;

  // Matched the same way face.plane will, so the preview cannot drift from it.
  const match = matchingFaces(faces, choice.normal)[choice.rank];
  return match === undefined ? null : makePlane(match.face.origin, match.face.normal);
}

const dialog = new FeatureDialog(viewportEl, graph, {
  onBeforeChange: () => history.capture(),
  onForget: () => {
    history.forget();
    refreshHistoryButtons();
  },
  onCommit: (nodeId) => {
    applySelection(nodeId, true);
    editor.reveal(nodeId);
    requestSolve();
  },
  onArmedChanged: (armed) => {
    document.body.classList.toggle('picking', armed);
    viewport.setEdgePicking(armed && dialog.isPickingEdges);
  },
  // The preview is in the graph already, so showing it is an ordinary solve.
  onPreviewChanged: (nodeId) => {
    refreshDragHandle(nodeId);
    requestSolve();
  },
  onSketch: (choice) => {
    const plane = planeValueFor(choice);
    if (plane === null) {
      statusEl.textContent = 'That plane has not been solved yet — try again in a moment.';
      return;
    }

    // A sketch starts as an empty node on the chosen plane, and drawing fills
    // it in. There is nothing to commit at the end, because everything drawn
    // has already been written to it.
    history.capture();
    try {
      const nodeId = createSketchNode(graph, choice);
      applySelection(nodeId, true);
      editor.reveal(nodeId);
      document.body.classList.add('sketching');
      sketchSession.enter(nodeId, plane);
    } catch (thrown) {
      statusEl.textContent = thrown instanceof Error ? thrown.message : String(thrown);
    }
  },
});

const sketchSession = new SketchSession(viewportEl, graph, viewport, {
  onBeforeChange: () => history.capture(),
  onChanged: () => requestSolve(),
  onExit: () => {
    document.body.classList.remove('sketching');
    // Leaving a sketch nobody drew in takes the node with it.
    if (selected !== null && (graph.getNode(selected) ?? null) === null) {
      applySelection(null, true);
    }
  },
});

/** Reopen the selected sketch, on whatever plane it is actually sitting on. */
function editSketch(): void {
  if (!SketchSession.editable(graph, selected)) {
    statusEl.textContent = 'Select a Sketch node first.';
    return;
  }

  const source = graph.incomingEdge(selected!, 'plane');
  const plane = source === undefined ? WORLD_XY : (lastPlanes[source.from.node] ?? null);
  if (plane === null) {
    statusEl.textContent = 'That sketch plane has not been solved yet — try again in a moment.';
    return;
  }

  document.body.classList.add('sketching');
  sketchSession.enter(selected!, plane);
}

/** The middle of a mesh's bounding box, in model units. */
function centreOfMesh(positions: Float32Array): Vec3 | null {
  if (positions.length === 0) return null;

  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!;
      low[axis] = Math.min(low[axis]!, value);
      high[axis] = Math.max(high[axis]!, value);
    }
  }
  return { x: (low[0]! + high[0]!) / 2, y: (low[1]! + high[1]!) / 2, z: (low[2]! + high[2]!) / 2 };
}

/** The plane a profile node was drawn on, as the graph currently has it. */
function planeOfProfile(nodeId: NodeId): PlaneValue {
  const source = graph.incomingEdge(nodeId, 'plane');
  const plane = source === undefined ? null : (lastPlanes[source.from.node] ?? null);
  return plane ?? WORLD_XY;
}

/**
 * An arrow on the model for the distance an extrude is about to travel.
 *
 * Only an extrude gets one: it is the feature whose number is a length along a
 * direction the model already has. A radius or a thickness has no such axis,
 * and an arrow pointing nowhere in particular would be worse than none.
 */
function refreshDragHandle(previewNodeId: NodeId | null): void {
  const spec = dialog.feature;
  const profile = dialog.operandNode('profile');

  if (previewNodeId === null || spec?.nodeType !== 'solid.extrude' || profile === null) {
    viewport.setDragHandle(null);
    return;
  }

  const plane = planeOfProfile(profile);
  viewport.setDragHandle({
    origin: lastCentres.get(profile) ?? plane.origin,
    direction: plane.normal,
    distance: dialog.numberOf('distance') ?? 0,
    onDrag: (distance) => dialog.setNumber('distance', distance),
  });
}

const toolbar = new Toolbar(viewportEl, tabs, (spec) => {
  if (spec.kind === 'edit') {
    editSketch();
    return;
  }
  dialog.open(spec, selected);
});

// --------------------------------------------------------------- file actions

function actionButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-button';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function newDocument(): void {
  // Clearing is an ordinary document edit, so Ctrl+Z brings the model back.
  history.capture();
  graph.restore({ version: 1, nodes: [], edges: [] });
  applySelection(null, true);
  requestSolve();
  statusEl.textContent = 'new document';
}

function saveDocument(): void {
  download(documentToText(graph.toJSON()), timestampedName('json'), 'application/json');
  statusEl.textContent = 'document saved';
}

async function openDocument(): Promise<void> {
  const file = await pickFile('.json,application/json');
  if (file === null) return;

  try {
    const restored = parseDocument(await file.text());
    history.capture();
    graph.restore(restored);
    applySelection(null, true);
    editor.frame();
    requestSolve();
    statusEl.textContent = `opened ${file.name}`;
  } catch (thrown) {
    statusEl.textContent = thrown instanceof Error ? thrown.message : String(thrown);
  }
}

function hasGeometryOutput(nodeId: NodeId): boolean {
  const node = graph.getNode(nodeId);
  if (node === undefined) return false;
  return registry.require(node.type).outputs.some((port) => port.type === 'geometry');
}

function requestExport(format: ExportFormat): void {
  const nodeIds =
    selected !== null && hasGeometryOutput(selected) ? [selected] : viewport.solidNodes();

  if (nodeIds.length === 0) {
    statusEl.textContent = 'nothing solid to export';
    return;
  }

  statusEl.textContent = `exporting ${format.toUpperCase()}…`;
  const message: MainToWorker = {
    type: 'export',
    requestId: ++requestId,
    format,
    document: graph.toJSON(),
    nodeIds,
  };
  worker.postMessage(message);
}

toolbar.appendAction(actionButton('New', 'Empty document', newDocument));
toolbar.appendAction(actionButton('Open', 'Open a saved document', () => void openDocument()));
toolbar.appendAction(actionButton('Save', 'Download this document', saveDocument));
toolbar.appendAction(actionButton('STL', 'Export mesh for printing', () => requestExport('stl')));
toolbar.appendAction(actionButton('STEP', 'Export solid for CAD', () => requestExport('step')));

const undoButton = actionButton('Undo', 'Ctrl+Z', () => applyHistory('undo'));
const redoButton = actionButton('Redo', 'Ctrl+Shift+Z', () => applyHistory('redo'));
toolbar.appendAction(undoButton);
toolbar.appendAction(redoButton);

function refreshHistoryButtons(): void {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
}

function applyHistory(action: 'undo' | 'redo'): void {
  // An open dialog's preview is in the document. Stepping the document out from
  // under it would strand nodes the dialog still thinks it owns, so undo takes
  // the dialog back first — which is the step the person just made.
  if (dialog.isOpen) {
    dialog.close();
    return;
  }

  const changed = action === 'undo' ? history.undo() : history.redo();
  if (!changed) return;
  refreshHistoryButtons();
  // A session open over an undone edit is holding a copy of a sketch the
  // document no longer has, so it reads the node again.
  if (sketchSession.isActive) sketchSession.refresh();
  requestSolve();
}

document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const target = event.target as HTMLElement | null;
  // Leave text fields to their own native undo, which still fires input events.
  if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    applyHistory('undo');
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    event.preventDefault();
    applyHistory('redo');
  } else if (key === 's') {
    event.preventDefault();
    saveDocument();
  } else if (key === 'o') {
    event.preventDefault();
    void openDocument();
  }
});

// ----------------------------------------------------------------- selection

/** A dialog waiting for an operand consumes the click instead of selecting. */
function applySelection(
  nodeId: NodeId | null,
  syncEditor: boolean,
  face: PickedFace | null = null,
): void {
  if (nodeId !== null && dialog.isArmed && dialog.offerPick(nodeId, face)) return;
  selected = nodeId;
  if (syncEditor) editor.setSelection(nodeId);
  viewport.setHighlight(nodeId);
}

/**
 * Turn a picked face into the selector the face.plane node will re-resolve with:
 * its normal, and its position among the faces pointing the same way.
 */
function describePickedFace(hit: FaceHit): PickedFace | null {
  if (hit.faceIndex === null) return null;
  const faces = viewport.facesOf(hit.nodeId);
  if (faces === undefined) return null;

  const picked = faces[hit.faceIndex];
  if (picked === undefined || !picked.planar) return null;

  const rank = matchingFaces(faces, picked.normal).findIndex((match) => match.face === picked);
  return rank < 0 ? null : { normal: picked.normal, rank };
}

dialog.onEdgesChanged((choice) => {
  viewport.clearChosenEdges();
  if (choice !== null) viewport.setChosenEdges(choice.nodeId, [...choice.picks.keys()]);
});

viewport.onEdgePick((hit) => {
  if (hit === null) return;
  const edge = viewport.edgesOf(hit.nodeId)?.[hit.edgeIndex];
  if (edge === undefined) return;
  dialog.offerEdge(hit.nodeId, {
    index: hit.edgeIndex,
    ref: { fraction: edge.fraction, direction: edge.direction, length: edge.length },
  });
});

// Hover feedback while picking edges, so it is obvious what a click will take.
viewport.canvas.addEventListener('pointermove', (event) => {
  if (!dialog.isPickingEdges) return;
  viewport.setHoveredEdge(viewport.edgeAt(event.clientX, event.clientY));
});

viewport.onPick((hit) => {
  viewport.setFaceHighlight(hit);
  if (hit === null) {
    applySelection(null, true);
    return;
  }
  applySelection(hit.nodeId, true, describePickedFace(hit));
});

// ------------------------------------------------------------------ controls

const sliderInputs = new Map<NodeId, { range: HTMLInputElement; readout: HTMLElement }>();

/** Named number nodes are the document's parameters, whatever document it is. */
function parameterNodes(): GraphNode[] {
  return graph.allNodes().filter((node) => node.type === 'math.number' && node.label !== undefined);
}

function sliderRange(value: number): { min: number; max: number } {
  const span = Math.max(10, Math.abs(value) * 3);
  return value < 0 ? { min: -span, max: span } : { min: 0, max: span };
}

function rebuildControls(): void {
  controls.replaceChildren();
  sliderInputs.clear();

  const parameters = parameterNodes();
  if (parameters.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'Label a Number node to make it a parameter.';
    controls.append(empty);
    return;
  }

  for (const node of parameters) {
    const current = Number(graph.inputValue(node.id, 'value') ?? 0);
    const { min, max } = sliderRange(current);

    const wrapper = document.createElement('label');
    wrapper.className = 'control';

    const row = document.createElement('div');
    row.className = 'label-row';
    const name = document.createElement('span');
    name.textContent = node.label ?? 'Number';
    const readout = document.createElement('span');
    readout.textContent = String(current);
    row.append(name, readout);

    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = '0.5';
    range.value = String(current);

    // One snapshot per gesture, so a drag is a single undo step.
    let captured = false;
    range.addEventListener('pointerdown', () => {
      captured = false;
    });
    range.addEventListener('keydown', () => {
      captured = false;
    });
    range.addEventListener('input', () => {
      const next = Number(range.value);
      if (!captured) {
        captured = true;
        history.capture();
      }
      readout.textContent = String(next);
      graph.setInput(node.id, 'value', next);
      requestSolve();
    });

    wrapper.append(row, range);
    controls.append(wrapper);
    sliderInputs.set(node.id, { range, readout });
  }
}

function syncSlider(nodeId: NodeId): void {
  const bound = sliderInputs.get(nodeId);
  if (bound === undefined) return;
  const value = String(graph.inputValue(nodeId, 'value'));
  bound.range.value = value;
  bound.readout.textContent = value;
}

rebuildControls();

// ------------------------------------------------------------------ autosave

let autosaveTimer = 0;
function scheduleAutosave(): void {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => {
    if (!writeAutosave(documentToText(graph.toJSON()))) {
      statusEl.textContent = 'autosave unavailable — save to a file instead';
    }
  }, 600);
}

// Editing a value in the node editor must move the slider that shows it: both
// panels are views of one document, not separate copies of the number.
graph.subscribe((change) => {
  refreshHistoryButtons();
  scheduleAutosave();

  if (change.kind === 'document-replaced') {
    rebuildControls();
    if (selected !== null && graph.getNode(selected) === undefined) applySelection(null, true);
    return;
  }
  if (change.kind === 'node-added' || change.kind === 'node-removed' || change.kind === 'node-renamed') {
    rebuildControls();
    return;
  }
  if (change.kind === 'input-changed' && change.portId === 'value') syncSlider(change.nodeId);
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
    if (restoredFromAutosave) statusEl.textContent += ' · restored last session';
    if (autosaveProblem !== null) {
      statusEl.textContent += `\ncould not reopen your last session: ${autosaveProblem}`;
    }
    requestSolve();
    return;
  }

  if (message.type === 'exported') {
    const mime = message.format === 'stl' ? 'model/stl' : 'application/step';
    download(message.data, timestampedName(message.format), mime);
    statusEl.textContent = `exported ${(message.data.byteLength / 1024).toFixed(0)} kB of ${message.format.toUpperCase()}`;
    return;
  }

  if (message.type === 'failed') {
    statusEl.textContent = `failed: ${message.message}`;
    inFlight = false;
    return;
  }

  lastPlanes = message.planes;
  lastReports = message.reports;
  for (const mesh of message.meshes) {
    lastMeshes.set(mesh.nodeId, mesh);
    const centre = centreOfMesh(mesh.positions);
    if (centre !== null) lastCentres.set(mesh.nodeId, centre);
  }
  for (const nodeId of [...lastMeshes.keys()]) {
    if (!message.visible.includes(nodeId)) lastMeshes.delete(nodeId);
  }
  solveCount += 1;
  lastVisible = message.visible;
  for (const mesh of message.meshes) viewport.setMesh(mesh);
  viewport.retain(message.visible);
  viewport.frameOnce();
  editor.setStatuses(message.reports);
  editor.setShown(message.visible);

  const errors = message.reports.filter((report) => report.error !== undefined);
  statsEl.textContent =
    `${message.stats.evaluated} evaluated · ${message.stats.cached} cached · ` +
    `${message.stats.errored} errored\nsolve ${message.solveMs.toFixed(1)} ms · ` +
    `mesh ${message.meshMs.toFixed(1)} ms · ${message.triangles} triangles sent` +
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

refreshHistoryButtons();
statusEl.textContent = 'loading OpenCASCADE kernel…';

if (import.meta.env.DEV) {
  Reflect.set(window, 'wirecad', {
    graph,
    viewport,
    editor,
    history,
    reports: () => lastReports,
    meshes: () => [...lastMeshes.values()],
    solves: () => solveCount,
    solve: () => requestSolve(),
    visible: () => lastVisible,
    pending: () => inFlight,
    starter: buildStarterModel,
    rejected: readRejected,
    autosaveProblem: () => autosaveProblem,
    select: (nodeId: NodeId) => applySelection(nodeId, true),
    dialog,
    handleAt: () => viewport.handleScreenPosition(),
    sketch: sketchSession,
    screenOfSketch: (u: number, v: number) => {
      const plane = lastPlanes[graph.incomingEdge(selected!, 'plane')?.from.node ?? ''] ?? WORLD_XY;
      return viewport.screenPositionOf(pointOnPlane(plane, u, v));
    },
  });
}
