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
import { edgeSchemas, matchEdgeRefs, unpackEdgeRefs } from './nodes/edges.js';
import { modifySchemas } from './nodes/modify.js';
import { planeNodes } from './nodes/plane.js';
import { geometrySchemas } from './nodes/solid.js';
import { FeatureDialog } from './ui/feature-dialog.js';
import type { PickedFace } from './ui/feature-dialog.js';
import type { FeatureSpec, PlaneChoice } from './ui/features.js';
import { createSketchNode, originPlaneNode, tabs } from './ui/features.js';
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
import type { FaceHit, GhostMode } from './viewport.js';
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
  // Reopening a feature is the dialogs' business, and so far only a sketch has
  // somewhere to be reopened into. A feature dialog that can load its own node
  // arrives behind these same two calls.
  canEdit: (nodeId) => SketchSession.editable(graph, nodeId),
  onEdit: (nodeId) => {
    applySelection(nodeId, true);
    editSketch(nodeId);
  },
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

/** Reopen a sketch, on whatever plane it is actually sitting on. */
function editSketch(nodeId: NodeId | null = selected): void {
  if (!SketchSession.editable(graph, nodeId)) {
    statusEl.textContent = 'Select a Sketch node first.';
    return;
  }

  const source = graph.incomingEdge(nodeId!, 'plane');
  const plane = source === undefined ? WORLD_XY : (lastPlanes[source.from.node] ?? null);
  if (plane === null) {
    statusEl.textContent = 'That sketch plane has not been solved yet — try again in a moment.';
    return;
  }

  document.body.classList.add('sketching');
  sketchSession.enter(nodeId!, plane);
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
 * The smallest a dragged radius or thickness may get. Zero is not a small
 * fillet, it is a failed one, and dragging past it should stop rather than
 * report an error the person did not ask for.
 */
const HANDLE_FLOOR = 0.1;

function unit(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length < 1e-9 ? { x: 0, y: 0, z: 1 } : {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

/**
 * Where a feature's number runs, and from where.
 *
 * Every number a dialog can drag is a length along some direction the model
 * already has: an extrude travels along its profile's normal, a fillet or
 * chamfer grows outward from the edge it rounds, a shell thickens inward from
 * the face it opens. A number with no such direction — there are none left, but
 * there could be — gets no arrow rather than an arbitrary one.
 */
function handleAxis(
  spec: FeatureSpec,
): { origin: Vec3; direction: Vec3; port: string; minimum?: number } | null {
  if (spec.nodeType === 'solid.extrude') {
    const profile = dialog.operandNode('profile');
    if (profile === null) return null;
    const plane = planeOfProfile(profile);
    return {
      origin: lastCentres.get(profile) ?? plane.origin,
      direction: plane.normal,
      port: 'distance',
    };
  }

  if (spec.nodeType === 'solid.fillet' || spec.nodeType === 'solid.chamfer') {
    const picked = pickedEdges;
    const index = picked?.indices[picked.indices.length - 1];
    if (picked === undefined || picked === null || index === undefined) return null;

    const edge = viewport.edgesOf(picked.nodeId)?.[index];
    const centre = lastCentres.get(picked.nodeId);
    if (edge === undefined || centre === undefined) return null;

    // Outward from the body, and square to the edge: the way the rounding
    // actually grows, rather than whichever way the edge happens to lie.
    const away = {
      x: edge.midpoint.x - centre.x,
      y: edge.midpoint.y - centre.y,
      z: edge.midpoint.z - centre.z,
    };
    const along = edge.direction;
    const projection = away.x * along.x + away.y * along.y + away.z * along.z;
    const outward = unit({
      x: away.x - along.x * projection,
      y: away.y - along.y * projection,
      z: away.z - along.z * projection,
    });

    return {
      origin: edge.midpoint,
      direction: outward,
      port: spec.nodeType === 'solid.fillet' ? 'radius' : 'distance',
      minimum: HANDLE_FLOOR,
    };
  }

  if (spec.nodeType === 'solid.shell') {
    const body = dialog.operandNode('solid');
    const picked = dialog.operandFace('solid');
    if (body === null || picked === null) return null;

    const faces = viewport.facesOf(body);
    const match = faces === undefined ? undefined : matchingFaces(faces, picked.normal)[picked.rank];
    if (match === undefined) return null;

    // A wall thickens into the body, away from the face being opened.
    return {
      origin: match.face.origin,
      direction: { x: -match.face.normal.x, y: -match.face.normal.y, z: -match.face.normal.z },
      port: 'thickness',
      minimum: HANDLE_FLOOR,
    };
  }

  return null;
}

/** An arrow on the model for the number the open dialog is about to commit. */
function refreshDragHandle(previewNodeId: NodeId | null): void {
  const spec = dialog.feature;
  const axis = spec === null ? null : handleAxis(spec);

  if (previewNodeId === null || axis === null) {
    viewport.setDragHandle(null);
    return;
  }

  viewport.setDragHandle({
    origin: axis.origin,
    direction: axis.direction,
    distance: dialog.numberOf(axis.port) ?? 0,
    ...(axis.minimum === undefined ? {} : { minimum: axis.minimum }),
    onDrag: (distance) => dialog.setNumber(axis.port, distance),
  });
}

const toolbar = new Toolbar(viewportEl, tabs, (spec) => {
  if (spec.kind === 'edit') {
    editSketch();
    return;
  }

  // The dialog takes the view from here: no leftover ghost from what was
  // selected a moment ago.
  ghostPin = null;
  edgesPin = null;
  viewport.clearChosenEdges();
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
  showWhatItMade(nodeId);
}

/**
 * Shows what the selected node is responsible for.
 *
 * A node in the middle of a chain has usually been replaced by what came after
 * it — a profile by the body extruded from it, a body by the fillet on it — so
 * clicking it says nothing on its own. Its result is put back on screen as a
 * ghost until something else is selected. A node that holds no geometry of its
 * own but points at some, like a set of picked edges, lights up what it points
 * at instead.
 */
function showWhatItMade(nodeId: NodeId | null): void {
  // While a dialog is up it owns the view, and selection means picking operands.
  if (dialog.isOpen) return;

  const before = `${ghostPin}/${edgesPin}`;
  ghostPin = null;
  edgesPin = null;

  const node = nodeId === null ? null : (graph.getNode(nodeId) ?? null);

  // A plane node makes no geometry — its whole content is a place in space — so
  // what it is responsible for is the plane itself, drawn where it is.
  const makesPlane =
    node !== null && graph.schemaOf(node.id).outputs.some((port) => port.type === 'plane');
  viewport.setSelectedPlane(makesPlane ? (lastPlanes[node!.id] ?? null) : null);

  if (node !== null) {
    const makes = graph
      .schemaOf(node.id)
      .outputs.some((port) => port.type === 'geometry' || port.type === 'sketch');
    if (makes) ghostPin = node.id;
    else if (node.type === 'edge.selection') edgesPin = bodyBehindSelection(node.id);
  }

  if (`${ghostPin}/${edgesPin}` === before) return;
  viewport.clearChosenEdges();
  requestSolve();
}

/** The body a set of picked edges was taken from, by way of what consumes it. */
function bodyBehindSelection(nodeId: NodeId): NodeId | null {
  for (const edge of graph.outgoingEdges(nodeId)) {
    const source = graph.incomingEdge(edge.to.node, 'solid');
    if (source !== undefined) return source.from.node;
  }
  return null;
}

/**
 * Shows the selected node's plane once the solve has worked out where it is. A
 * plane made a moment ago has no position yet, and without this the square for
 * it would appear only when something else happened to redraw.
 */
function refreshPlaneHighlight(): void {
  if (selected === null || dialog.isOpen) return;
  const node = graph.getNode(selected) ?? null;
  if (node === null) return;
  if (!graph.schemaOf(node.id).outputs.some((port) => port.type === 'plane')) return;
  viewport.setSelectedPlane(lastPlanes[node.id] ?? null);
}

/** Lights up the edges a selected edge selection refers to, once they are drawn. */
function refreshEdgeHighlight(): void {
  const body = edgesPin;
  if (body === null || selected === null) return;

  const edges = viewport.edgesOf(body);
  if (edges === undefined) return;

  const stored = graph.inputValue(selected, 'refs');
  if (!Array.isArray(stored)) return;

  const refs = unpackEdgeRefs(stored.filter((value): value is number => typeof value === 'number'));
  viewport.setChosenEdges(
    body,
    matchEdgeRefs(edges, refs).filter((index) => index >= 0),
  );
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
  pickedEdges = choice === null ? null : { nodeId: choice.nodeId, indices: [...choice.picks.keys()] };
  viewport.clearChosenEdges();
  if (choice !== null) viewport.setChosenEdges(choice.nodeId, [...choice.picks.keys()]);

  // Picking edges off a body while a preview replaces that body would take it
  // out of the view after the first one. It stays, as edges alone, and is the
  // only thing edge picking will hit until the dialog is done with it.
  pickPin = choice?.nodeId ?? null;
  viewport.setEdgeSource(pickPin);
  requestSolve();
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

// Clicking one of the origin squares means that plane, which in this program is
// a node: the document gains one unless it already has that plane. Selecting it
// is what feeds it to whatever is asking, exactly as clicking a face does.
viewport.onPickDatum((axis) => {
  const existing = graph.allNodes().find((node) => node.type === `plane.${axis}`);
  if (existing === undefined) history.capture();

  const { nodeId, created } = originPlaneNode(graph, axis);
  viewport.setFaceHighlight(null);
  applySelection(nodeId, true);
  editor.reveal(nodeId);
  if (created) requestSolve();
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
/** The body an open dialog is picking from, kept on screen while it does. */
let pickPin: NodeId | null = null;
/** A selected node's own result, shown through whatever came after it. */
let ghostPin: NodeId | null = null;
/** The body a selected edge selection refers to, so its edges can be shown. */
let edgesPin: NodeId | null = null;
/** The edges the open dialog has been given, for the handle to sit on. */
let pickedEdges: { nodeId: NodeId; indices: number[] } | null = null;

/** Everything the view is being asked to show beyond the model itself. */
function pinnedNodes(): NodeId[] {
  const pins = [pickPin, ghostPin, edgesPin].filter((id): id is NodeId => id !== null);
  return [...new Set(pins)];
}

function requestSolve(): void {
  if (inFlight) {
    dirty = true;
    return;
  }
  inFlight = true;
  const message: MainToWorker = {
    type: 'solve',
    requestId: ++requestId,
    document: graph.toJSON(),
    pinned: pinnedNodes(),
  };
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

  // A body only on screen because it was asked for is drawn as a ghost: edges
  // alone when something is being picked off it, faint when it is what the
  // selected node made. One that would be on screen anyway is left alone.
  const forced = new Set(message.pinnedShown);
  const ghosts = new Map<NodeId, GhostMode>();
  for (const nodeId of [pickPin, edgesPin]) {
    if (nodeId !== null && forced.has(nodeId)) ghosts.set(nodeId, 'edges');
  }
  for (const nodeId of message.pinnedShown) {
    // A node that says which faces it made shows those and nothing else: a
    // fillet is responsible for its rounding, not for the body it handed on.
    if (!ghosts.has(nodeId)) {
      ghosts.set(nodeId, viewport.hasFeatureFaces(nodeId) ? 'faces' : 'faint');
    }
  }
  viewport.setGhosts(ghosts);

  // When such a node's result is still the model, there is nothing to ghost;
  // the faces it made are picked out on the model itself instead.
  viewport.setLitFaces(
    ghostPin !== null && !forced.has(ghostPin) && viewport.hasFeatureFaces(ghostPin)
      ? ghostPin
      : null,
  );
  refreshEdgeHighlight();
  refreshPlaneHighlight();
  viewport.frameOnce();
  editor.setStatuses(message.reports);
  editor.setShown(message.visible);

  const errors = message.reports.filter((report) => report.error !== undefined);
  statsEl.textContent =
    `${message.stats.evaluated} evaluated · ${message.stats.cached} cached · ` +
    `${message.stats.errored} errored` +
    (message.stats.suppressed > 0 ? ` · ${message.stats.suppressed} suppressed` : '') +
    `\nsolve ${message.solveMs.toFixed(1)} ms · ` +
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
