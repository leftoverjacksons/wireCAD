import type { EvalStats, NodeStatus } from '../core/evaluator.js';
import type { SerializedGraph } from '../core/graph.js';
import type { NodeId } from '../core/types.js';

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

export interface MeshPayload {
  nodeId: NodeId;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export interface SolvedMessage {
  type: 'solved';
  requestId: number;
  reports: NodeReport[];
  visible: NodeId[];
  meshes: MeshPayload[];
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
