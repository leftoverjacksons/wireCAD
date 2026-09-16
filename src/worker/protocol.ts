import type { EvalStats, NodeStatus } from '../core/evaluator.js';
import type { SerializedGraph } from '../core/graph.js';
import type { NodeId, PlaneValue } from '../core/types.js';
import type { FaceInfo } from '../geometry/kernel.js';

export interface SolveRequest {
  type: 'solve';
  requestId: number;
  document: SerializedGraph;
}

export type MainToWorker = SolveRequest;

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

export type WorkerToMain = ReadyMessage | SolvedMessage | FailedMessage;
