/// <reference lib="webworker" />
import { LruCache } from '../core/cache.js';
import { Evaluator } from '../core/evaluator.js';
import { Graph } from '../core/graph.js';
import { NodeRegistry } from '../core/registry.js';
import type { NodeId, PlaneValue } from '../core/types.js';
import { isPlane } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { disposeCacheEntry, isGeometry, loadKernel, tessellate } from '../geometry/kernel.js';
import { createFaceNodes } from '../nodes/face.js';
import { mathNodes } from '../nodes/math.js';
import { planeNodes } from '../nodes/plane.js';
import { createGeometryNodes } from '../nodes/solid.js';
import type { MainToWorker, MeshPayload, NodeReport, SolveRequest, WorkerToMain } from './protocol.js';

let oc: OpenCascadeInstance;
let registry: NodeRegistry;
let evaluator: Evaluator;

/** Hash of the mesh most recently transferred for a node, to avoid re-sending. */
const sentHashes = new Map<NodeId, string>();
const pending: SolveRequest[] = [];
let ready = false;

function post(message: WorkerToMain, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer);
}

function solve(request: SolveRequest): void {
  const graph = Graph.fromJSON(registry, request.document);

  const solveStart = performance.now();
  const result = evaluator.evaluate(graph);
  const solveMs = performance.now() - solveStart;

  const reports: NodeReport[] = [];
  for (const [nodeId, nodeResult] of result.results) {
    reports.push(
      nodeResult.error === undefined
        ? { nodeId, status: nodeResult.status }
        : { nodeId, status: nodeResult.status, error: nodeResult.error },
    );
  }

  const planes: Record<NodeId, PlaneValue> = {};
  for (const [nodeId, nodeResult] of result.results) {
    for (const value of Object.values(nodeResult.outputs)) {
      if (isPlane(value)) planes[nodeId] = value;
    }
  }

  const visible: NodeId[] = [];
  const meshes: MeshPayload[] = [];
  const transfer: Transferable[] = [];
  let triangles = 0;
  const meshStart = performance.now();

  for (const node of graph.allNodes()) {
    const definition = registry.require(node.type);

    // A solid is superseded only by something that produces geometry from it.
    // A query node such as face.plane reads the solid without replacing it, so
    // the body must stay on screen.
    const supersededBy = (portId: string): boolean =>
      graph
        .outgoingEdges(node.id)
        .filter((edge) => edge.from.port === portId)
        .some((edge) =>
          registry
            .require(graph.requireNode(edge.to.node).type)
            .outputs.some((port) => port.type === 'geometry'),
        );

    // Sketches always show, so a profile stays pickable once a feature uses it.
    const displayable = definition.outputs.find(
      (port) => port.type === 'sketch' || (port.type === 'geometry' && !supersededBy(port.id)),
    );
    if (displayable === undefined) continue;

    const nodeResult = result.results.get(node.id);
    if (nodeResult === undefined) continue;
    if (nodeResult.status === 'error' || nodeResult.status === 'skipped') continue;

    const value = nodeResult.outputs[displayable.id];
    if (value === undefined || !isGeometry(value)) continue;

    visible.push(node.id);
    if (sentHashes.get(node.id) === nodeResult.hash) continue;

    const buffers = tessellate(oc, value.handle as Shape);
    triangles += buffers.indices.length / 3;
    meshes.push({
      nodeId: node.id,
      kind: displayable.type === 'sketch' ? 'sketch' : 'solid',
      ...buffers,
    });
    transfer.push(
      buffers.positions.buffer,
      buffers.normals.buffer,
      buffers.indices.buffer,
      buffers.faceIds.buffer,
    );
    sentHashes.set(node.id, nodeResult.hash);
  }

  // A node that stops being visible must re-send when it returns, because the
  // main thread drops its mesh in the meantime.
  const stillVisible = new Set(visible);
  for (const nodeId of [...sentHashes.keys()]) {
    if (!stillVisible.has(nodeId)) sentHashes.delete(nodeId);
  }

  post(
    {
      type: 'solved',
      requestId: request.requestId,
      reports,
      visible,
      meshes,
      planes,
      stats: result.stats,
      solveMs,
      meshMs: performance.now() - meshStart,
      triangles,
    },
    transfer,
  );
}

function handle(request: SolveRequest): void {
  try {
    solve(request);
  } catch (thrown) {
    post({
      type: 'failed',
      requestId: request.requestId,
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  if (message.type !== 'solve') return;
  if (!ready) {
    // Keep only the newest request; older parameter values are already stale.
    pending.length = 0;
    pending.push(message);
    return;
  }
  handle(message);
};

async function start(): Promise<void> {
  const started = performance.now();
  oc = await loadKernel();

  registry = new NodeRegistry();
  registry.registerAll(mathNodes);
  registry.registerAll(planeNodes);
  registry.registerAll(createGeometryNodes(oc));
  registry.registerAll(createFaceNodes(oc));
  evaluator = new Evaluator(registry, new LruCache(256, disposeCacheEntry));

  ready = true;
  post({ type: 'ready', loadMs: performance.now() - started });

  const queued = pending.pop();
  pending.length = 0;
  if (queued !== undefined) handle(queued);
}

void start();
