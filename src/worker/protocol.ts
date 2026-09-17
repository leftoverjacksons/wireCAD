import type { EvalStats, NodeStatus } from '../core/evaluator.js';
import type { SerializedGraph } from '../core/graph.js';
import type { NodeId, PlaneValue } from '../core/types.js';
import type { EdgeInfo, FaceInfo } from '../geometry/kernel.js';

export interface SolveRequest {
  type: 'solve';
  requestId: number;
  document: SerializedGraph;
  /**
   * Nodes to keep on screen even though something downstream has replaced them.
   *
   * A feature being set up replaces the body its operands are being picked
   * from, which would take that body — and the edges still being picked off it
   * — out of the view mid-gesture.
   */
  pinned?: NodeId[];
}

export type ExportFormat = 'stl' | 'step';

export interface ExportRequest {
  type: 'export';
  requestId: number;
  format: ExportFormat;
  document: SerializedGraph;
  nodeIds: NodeId[];
}

export type MainToWorker = SolveRequest | ExportRequest;

export interface ExportedMessage {
  type: 'exported';
  requestId: number;
  format: ExportFormat;
  /** Always backed by a fresh, transferable ArrayBuffer — never the WASM heap. */
  data: Uint8Array<ArrayBuffer>;
}

export interface ReadyMessage {
  type: 'ready';
  loadMs: number;
}

export interface NodeReport {
  nodeId: NodeId;
  status: NodeStatus;
  error?: string;
}

export type MeshKind = 'solid' | 'sketch';

export interface MeshPayload {
  nodeId: NodeId;
  kind: MeshKind;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceIds: Uint32Array;
  faces: FaceInfo[];
  edgePositions: Float32Array;
  edgeIds: Uint32Array;
  edges: EdgeInfo[];
}

export interface SolvedMessage {
  type: 'solved';
  requestId: number;
  reports: NodeReport[];
  visible: NodeId[];
  meshes: MeshPayload[];
  /** Resolved planes, so the interface can sketch on whatever a node produced. */
  planes: Record<NodeId, PlaneValue>;
  stats: EvalStats;
  solveMs: number;
  meshMs: number;
  triangles: number;
}

export interface FailedMessage {
  type: 'failed';
  requestId: number;
  message: string;
}

export type WorkerToMain = ReadyMessage | SolvedMessage | FailedMessage | ExportedMessage;
