import type { PortLookup } from './registry.js';
import type { Edge, EdgeId, GraphNode, NodeId, PortId, PortRef, Value } from './types.js';
import { typesCompatible } from './types.js';

export type GraphChange =
  | { kind: 'node-added'; nodeId: NodeId }
  | { kind: 'node-removed'; nodeId: NodeId }
  | { kind: 'node-moved'; nodeId: NodeId }
  | { kind: 'node-renamed'; nodeId: NodeId }
  | { kind: 'input-changed'; nodeId: NodeId; portId: PortId }
  | { kind: 'edge-added'; edgeId: EdgeId }
  | { kind: 'edge-removed'; edgeId: EdgeId };

export type GraphListener = (change: GraphChange) => void;

export interface SerializedGraph {
  version: 1;
  nodes: GraphNode[];
  edges: Edge[];
}

export interface AddNodeOptions {
  id?: NodeId;
  label?: string;
  position?: { x: number; y: number };
  inputs?: Record<PortId, Value>;
}

/** Position and label are presentation-only and never affect evaluation. */
export function affectsEvaluation(change: GraphChange): boolean {
  return change.kind !== 'node-moved' && change.kind !== 'node-renamed';
}

export class Graph {
  private nodes = new Map<NodeId, GraphNode>();
  private edges = new Map<EdgeId, Edge>();
  private outgoing = new Map<NodeId, Set<EdgeId>>();
  private incoming = new Map<NodeId, Set<EdgeId>>();
  private listeners = new Set<GraphListener>();
  private counter = 0;

  constructor(readonly registry: PortLookup) {}

  private freshId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private emit(change: GraphChange): void {
    for (const listener of this.listeners) listener(change);
  }

  subscribe(listener: GraphListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addNode(type: string, options: AddNodeOptions = {}): GraphNode {
    const definition = this.registry.require(type);
    const id = options.id ?? this.freshId('n');
    if (this.nodes.has(id)) throw new Error(`Duplicate node id: ${id}`);

    const inputs: Record<PortId, Value> = {};
    for (const [portId, value] of Object.entries(options.inputs ?? {})) {
      if (!definition.inputs.some((p) => p.id === portId)) {
        throw new Error(`Node type ${type} has no input port "${portId}"`);
      }
      inputs[portId] = value;
    }

    const node: GraphNode = {
      id,
      type,
      position: options.position ?? { x: 0, y: 0 },
      inputs,
    };
    if (options.label !== undefined) node.label = options.label;

    this.nodes.set(id, node);
    this.outgoing.set(id, new Set());
    this.incoming.set(id, new Set());
    this.emit({ kind: 'node-added', nodeId: id });
    return node;
  }

  removeNode(nodeId: NodeId): void {
    if (!this.nodes.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
    const incident = [
      ...(this.incoming.get(nodeId) ?? []),
      ...(this.outgoing.get(nodeId) ?? []),
    ];
    for (const edgeId of incident) this.disconnect(edgeId);
    this.nodes.delete(nodeId);
    this.incoming.delete(nodeId);
    this.outgoing.delete(nodeId);
    this.emit({ kind: 'node-removed', nodeId });
  }

  getNode(nodeId: NodeId): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }

  requireNode(nodeId: NodeId): GraphNode {
    const node = this.nodes.get(nodeId);
    if (node === undefined) throw new Error(`Unknown node: ${nodeId}`);
    return node;
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): Edge[] {
    return [...this.edges.values()];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  setInput(nodeId: NodeId, portId: PortId, value: Value): void {
    const node = this.requireNode(nodeId);
    if (this.registry.inputPort(node.type, portId) === undefined) {
      throw new Error(`Node type ${node.type} has no input port "${portId}"`);
    }
    node.inputs[portId] = value;
    this.emit({ kind: 'input-changed', nodeId, portId });
  }

  /** Literal on the port, else the port's declared default, else null. */
  inputValue(nodeId: NodeId, portId: PortId): Value {
    const node = this.requireNode(nodeId);
    const literal = node.inputs[portId];
    if (literal !== undefined) return literal;
    const port = this.registry.inputPort(node.type, portId);
    return port?.default ?? null;
  }

  setPosition(nodeId: NodeId, position: { x: number; y: number }): void {
    this.requireNode(nodeId).position = position;
    this.emit({ kind: 'node-moved', nodeId });
  }

  setLabel(nodeId: NodeId, label: string): void {
    this.requireNode(nodeId).label = label;
    this.emit({ kind: 'node-renamed', nodeId });
  }

  connect(from: PortRef, to: PortRef, edgeId?: EdgeId): Edge {
    const source = this.requireNode(from.node);
    const target = this.requireNode(to.node);

    const outPort = this.registry.outputPort(source.type, from.port);
    if (outPort === undefined) {
      throw new Error(`Node type ${source.type} has no output port "${from.port}"`);
    }
    const inPort = this.registry.inputPort(target.type, to.port);
    if (inPort === undefined) {
      throw new Error(`Node type ${target.type} has no input port "${to.port}"`);
    }
    if (!typesCompatible(outPort.type, inPort.type)) {
      throw new Error(
        `Cannot connect ${outPort.type} to ${inPort.type} (${from.node}.${from.port} -> ${to.node}.${to.port})`,
      );
    }
    if (this.incomingEdge(to.node, to.port) !== undefined) {
      throw new Error(`Input port already connected: ${to.node}.${to.port}`);
    }
    if (this.reaches(to.node, from.node)) {
      throw new Error(`Connection would create a cycle: ${from.node} -> ${to.node}`);
    }

    const id = edgeId ?? this.freshId('e');
    if (this.edges.has(id)) throw new Error(`Duplicate edge id: ${id}`);

    const edge: Edge = { id, from, to };
    this.edges.set(edge.id, edge);
    this.outgoing.get(from.node)!.add(edge.id);
    this.incoming.get(to.node)!.add(edge.id);
    this.emit({ kind: 'edge-added', edgeId: edge.id });
    return edge;
  }

  disconnect(edgeId: EdgeId): void {
    const edge = this.edges.get(edgeId);
    if (edge === undefined) throw new Error(`Unknown edge: ${edgeId}`);
    this.edges.delete(edgeId);
    this.outgoing.get(edge.from.node)?.delete(edgeId);
    this.incoming.get(edge.to.node)?.delete(edgeId);
    this.emit({ kind: 'edge-removed', edgeId });
  }

  incomingEdges(nodeId: NodeId): Edge[] {
    const ids = this.incoming.get(nodeId);
    if (ids === undefined) return [];
    return [...ids].map((id) => this.edges.get(id)!);
  }

  outgoingEdges(nodeId: NodeId): Edge[] {
    const ids = this.outgoing.get(nodeId);
    if (ids === undefined) return [];
    return [...ids].map((id) => this.edges.get(id)!);
  }

  incomingEdge(nodeId: NodeId, portId: PortId): Edge | undefined {
    return this.incomingEdges(nodeId).find((edge) => edge.to.port === portId);
  }

  /** True if `target` is reachable from `source` by following wires downstream. */
  private reaches(source: NodeId, target: NodeId): boolean {
    if (source === target) return true;
    const stack: NodeId[] = [source];
    const seen = new Set<NodeId>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const edge of this.outgoingEdges(current)) {
        if (edge.to.node === target) return true;
        stack.push(edge.to.node);
      }
    }
    return false;
  }

  downstreamOf(nodeId: NodeId): Set<NodeId> {
    const result = new Set<NodeId>();
    const stack: NodeId[] = [nodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edge of this.outgoingEdges(current)) {
        if (result.has(edge.to.node)) continue;
        result.add(edge.to.node);
        stack.push(edge.to.node);
      }
    }
    return result;
  }

  topologicalOrder(): NodeId[] {
    const indegree = new Map<NodeId, number>();
    for (const id of this.nodes.keys()) indegree.set(id, 0);
    for (const edge of this.edges.values()) {
      indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
    }

    const queue: NodeId[] = [];
    for (const [id, degree] of indegree) if (degree === 0) queue.push(id);

    const order: NodeId[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      order.push(id);
      for (const edge of this.outgoingEdges(id)) {
        const remaining = (indegree.get(edge.to.node) ?? 0) - 1;
        indegree.set(edge.to.node, remaining);
        if (remaining === 0) queue.push(edge.to.node);
      }
    }

    if (order.length !== this.nodes.size) throw new Error('Graph contains a cycle');
    return order;
  }

  toJSON(): SerializedGraph {
    return {
      version: 1,
      nodes: this.allNodes().map((node) => ({ ...node, inputs: { ...node.inputs } })),
      edges: this.allEdges(),
    };
  }

  static fromJSON(registry: PortLookup, data: SerializedGraph): Graph {
    if (data.version !== 1) throw new Error(`Unsupported document version: ${data.version}`);
    const graph = new Graph(registry);
    for (const node of data.nodes) {
      graph.addNode(node.type, {
        id: node.id,
        position: node.position,
        inputs: node.inputs,
        ...(node.label !== undefined ? { label: node.label } : {}),
      });
    }
    for (const edge of data.edges) graph.connect(edge.from, edge.to, edge.id);

    let highest = 0;
    for (const id of [...data.nodes.map((n) => n.id), ...data.edges.map((e) => e.id)]) {
      const suffix = Number.parseInt(id.slice(1), 10);
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
    }
    graph.counter = highest;
    return graph;
  }
}
