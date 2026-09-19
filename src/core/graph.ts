import type { PortLookup } from './registry.js';
import type {
  Edge,
  EdgeId,
  GraphNode,
  NodeId,
  NodeSchema,
  PortDef,
  PortId,
  PortRef,
  Value,
} from './types.js';
import { typesCompatible } from './types.js';

export type GraphChange =
  | { kind: 'node-added'; nodeId: NodeId }
  | { kind: 'node-removed'; nodeId: NodeId }
  | { kind: 'node-moved'; nodeId: NodeId }
  | { kind: 'node-renamed'; nodeId: NodeId }
  | { kind: 'node-visibility'; nodeId: NodeId }
  | { kind: 'node-suppressed'; nodeId: NodeId }
  | { kind: 'input-changed'; nodeId: NodeId; portId: PortId }
  | { kind: 'edge-added'; edgeId: EdgeId }
  | { kind: 'edge-removed'; edgeId: EdgeId }
  | { kind: 'document-replaced' };

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
  visible?: boolean;
  suppressed?: boolean;
  /**
   * Drop literals for ports this node does not have, instead of refusing.
   *
   * Only for loading a document. A literal with no port cannot affect anything,
   * so keeping the document openable is worth more than insisting on it; a
   * programmer setting a port that is not there still wants to be told.
   */
  lenient?: boolean;
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
  /** While set, changes are made without telling anybody: loading a document. */
  private quiet = false;

  constructor(readonly registry: PortLookup) {}

  private freshId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private emit(change: GraphChange): void {
    if (this.quiet) return;
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

    // Ports a node grows depend on what it is holding, so the values being set
    // are also what decides which ports exist. A saved document carries literals
    // for grown ports, and reloading it has to accept them.
    const provided = options.inputs ?? {};
    const grown = definition.expand?.(provided).inputs ?? [];
    const known = new Set([...definition.inputs, ...grown].map((port) => port.id));

    const inputs: Record<PortId, Value> = {};
    for (const [portId, value] of Object.entries(provided)) {
      if (!known.has(portId)) {
        if (options.lenient === true) continue;
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
    if (options.visible !== undefined) node.visible = options.visible;
    if (options.suppressed !== undefined) node.suppressed = options.suppressed;

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

  /**
   * The node's ports, including any it grew for itself. Everything that reads
   * ports goes through here; the registry only knows the type's fixed ones.
   */
  schemaOf(nodeId: NodeId): NodeSchema {
    const node = this.requireNode(nodeId);
    const base = this.registry.require(node.type);
    if (base.expand === undefined) return base;

    const grown = base.expand(node.inputs);
    return {
      ...base,
      inputs: [...base.inputs, ...(grown.inputs ?? [])],
      outputs: [...base.outputs, ...(grown.outputs ?? [])],
    };
  }

  inputPortOf(nodeId: NodeId, portId: PortId): PortDef | undefined {
    return this.schemaOf(nodeId).inputs.find((port) => port.id === portId);
  }

  outputPortOf(nodeId: NodeId, portId: PortId): PortDef | undefined {
    return this.schemaOf(nodeId).outputs.find((port) => port.id === portId);
  }

  setInput(nodeId: NodeId, portId: PortId, value: Value): void {
    const node = this.requireNode(nodeId);
    if (this.inputPortOf(nodeId, portId) === undefined) {
      throw new Error(`Node type ${node.type} has no input port "${portId}"`);
    }
    node.inputs[portId] = value;
    this.prune(node);
    this.emit({ kind: 'input-changed', nodeId, portId });
  }

  /**
   * Drops literals for ports the node no longer has.
   *
   * The ports a node grows depend on its own inputs, so setting one can take
   * another away: deleting a sketch dimension takes its port with it. The
   * number left behind would mean nothing, and worse, it would be refused the
   * next time the document was opened — which is a file that will not load,
   * reported far from what caused it.
   */
  private prune(node: GraphNode): void {
    if (this.registry.require(node.type).expand === undefined) return;

    const known = new Set(this.schemaOf(node.id).inputs.map((port) => port.id));
    for (const portId of Object.keys(node.inputs)) {
      if (!known.has(portId)) delete node.inputs[portId];
    }
  }

  /** Literal on the port, else the port's declared default, else null. */
  inputValue(nodeId: NodeId, portId: PortId): Value {
    const node = this.requireNode(nodeId);
    const literal = node.inputs[portId];
    if (literal !== undefined) return literal;
    const port = this.inputPortOf(nodeId, portId);
    return port?.default ?? null;
  }

  setPosition(nodeId: NodeId, position: { x: number; y: number }): void {
    this.requireNode(nodeId).position = position;
    this.emit({ kind: 'node-moved', nodeId });
  }

  /** An empty name hands the node back to the label its type carries. */
  setLabel(nodeId: NodeId, label: string | undefined): void {
    const node = this.requireNode(nodeId);
    if (label === undefined || label.trim() === '') delete node.label;
    else node.label = label.trim();
    this.emit({ kind: 'node-renamed', nodeId });
  }

  /** `undefined` hands the node back to the automatic rule. */
  setVisibility(nodeId: NodeId, visible: boolean | undefined): void {
    const node = this.requireNode(nodeId);
    if (visible === undefined) delete node.visible;
    else node.visible = visible;
    this.emit({ kind: 'node-visibility', nodeId });
  }

  /**
   * Holds the feature back, or lets it act again.
   *
   * The graph only records the answer. What a suppressed node hands on is the
   * evaluator's business, and whether there is anything for it to hand on is a
   * question about ports that `passThroughOf` answers.
   */
  setSuppressed(nodeId: NodeId, suppressed: boolean | undefined): void {
    const node = this.requireNode(nodeId);
    if (suppressed === undefined || !suppressed) delete node.suppressed;
    else node.suppressed = true;
    this.emit({ kind: 'node-suppressed', nodeId });
  }

  /** The reason this connection would be refused, or null if it is allowed. */
  canConnect(from: PortRef, to: PortRef): string | null {
    const source = this.nodes.get(from.node);
    if (source === undefined) return `Unknown node: ${from.node}`;
    const target = this.nodes.get(to.node);
    if (target === undefined) return `Unknown node: ${to.node}`;

    const outPort = this.outputPortOf(from.node, from.port);
    if (outPort === undefined) {
      return `Node type ${source.type} has no output port "${from.port}"`;
    }
    const inPort = this.inputPortOf(to.node, to.port);
    if (inPort === undefined) {
      return `Node type ${target.type} has no input port "${to.port}"`;
    }
    if (!typesCompatible(outPort.type, inPort.type)) {
      return `Cannot connect ${outPort.type} to ${inPort.type}`;
    }
    if (this.incomingEdge(to.node, to.port) !== undefined) {
      return `Input "${inPort.label}" is already connected`;
    }
    if (this.reaches(to.node, from.node)) {
      return 'That connection would create a cycle';
    }
    return null;
  }

  connect(from: PortRef, to: PortRef, edgeId?: EdgeId): Edge {
    const problem = this.canConnect(from, to);
    if (problem !== null) throw new Error(problem);

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

  /**
   * Replaces everything here with a document.
   *
   * Loading can fail part way through — a type this build does not have, a port
   * that no longer exists — and a half-loaded document is worse than none: what
   * did get in keeps the ids it was given, so the next node added collides with
   * it, and the failure surfaces somewhere else entirely as a duplicate id. So
   * the document is loaded into a graph of its own first, and only one that
   * loaded completely is taken on here.
   */
  private load(data: SerializedGraph): void {
    const scratch = new Graph(this.registry);
    scratch.absorb(data);

    this.nodes = scratch.nodes;
    this.edges = scratch.edges;
    this.outgoing = scratch.outgoing;
    this.incoming = scratch.incoming;
    this.counter = scratch.counter;
  }

  /** Fills a graph from a document, leaving it part filled if it cannot finish. */
  private absorb(data: SerializedGraph): void {
    const previous = this.quiet;
    this.quiet = true;
    try {
      for (const node of data.nodes) {
        this.addNode(node.type, {
          id: node.id,
          lenient: true,
          position: { ...node.position },
          inputs: node.inputs,
          ...(node.label !== undefined ? { label: node.label } : {}),
          ...(node.visible !== undefined ? { visible: node.visible } : {}),
          ...(node.suppressed !== undefined ? { suppressed: node.suppressed } : {}),
        });
      }
      for (const edge of data.edges) this.connect(edge.from, edge.to, edge.id);
    } finally {
      this.quiet = previous;
    }

    let highest = 0;
    for (const id of [...data.nodes.map((n) => n.id), ...data.edges.map((e) => e.id)]) {
      const suffix = Number.parseInt(id.slice(1), 10);
      if (Number.isFinite(suffix) && suffix > highest) highest = suffix;
    }
    this.counter = highest;
  }

  /** Replace the whole document in place, so existing views keep their handle on it. */
  restore(data: SerializedGraph): void {
    if (data.version !== 1) throw new Error(`Unsupported document version: ${data.version}`);
    this.load(data);
    this.emit({ kind: 'document-replaced' });
  }

  static fromJSON(registry: PortLookup, data: SerializedGraph): Graph {
    if (data.version !== 1) throw new Error(`Unsupported document version: ${data.version}`);
    const graph = new Graph(registry);
    graph.load(data);
    return graph;
  }
}
