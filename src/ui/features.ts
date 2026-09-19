import type { Graph } from '../core/graph.js';
import { spliceAfter } from '../core/rewire.js';
import type { DataType, NodeId, PortRef, Vec3 } from '../core/types.js';
import { EDGE_STRIDE } from '../nodes/edges.js';
import { EXTRUDE_OPERATIONS } from '../nodes/solid.js';
import { COLUMN_GAP, NODE_WIDTH, ROW_GAP, nodeHeight } from './metrics.js';

/**
 * 'face' is not a port type. It means: pick a face, wire this geometry port to
 * the body it belongs to, and write the selector into the node's nx/ny/nz/rank
 * inputs — the same normal-and-rank reference the face nodes use.
 *
 * 'edges' works the same way for a set of edges: it wires this geometry port to
 * the body, and puts the references in an Edge Selection node wired to `edges`.
 */
export type OperandKind =
  | Extract<DataType, 'sketch' | 'geometry' | 'plane'>
  | 'face'
  | 'edges';

export const FACE_SELECTOR_PORTS = ['nx', 'ny', 'nz', 'rank'] as const;

export interface OperandSpec {
  id: string;
  label: string;
  type: OperandKind;
  /** Leaving it empty falls back to the node's declared port default. */
  optional?: boolean;
}

export interface NumberSpec {
  id: string;
  label: string;
  value: number;
}

/** A fixed set of answers, such as what an extrude does to the body it meets. */
export interface ChoiceSpec {
  id: string;
  label: string;
  options: readonly string[];
  value: string;
}

export interface FeatureSpec {
  id: string;
  label: string;
  nodeType: string;
  operands: readonly OperandSpec[];
  numbers: readonly NumberSpec[];
  choices?: readonly ChoiceSpec[];
  /**
   * 'sketch' hands off to interactive drawing instead of building a node, and
   * 'edit' reopens the sketch already selected rather than making anything.
   */
  kind?: 'node' | 'sketch' | 'edit';
  /**
   * Whether this feature goes *into* the chain at its first operand rather than
   * onto the end of it — taking everything that was reading that operand with
   * it, so what comes after is built on the result instead of on the operand.
   *
   * Moving a body needs this and nothing else does yet: a move appended after a
   * bored block is a second body sitting beside the first, where what was meant
   * was the block moving and the bore going with it. At the end of a chain,
   * where nothing is reading the operand, it is an ordinary connect.
   */
  splice?: boolean;
}

export interface FeatureGroup {
  label: string;
  features: readonly FeatureSpec[];
}

export interface FeatureTab {
  id: string;
  label: string;
  groups: readonly FeatureGroup[];
}

const sketchPlane: OperandSpec = {
  id: 'plane',
  label: 'Plane',
  type: 'plane',
  optional: true,
};

function combine(id: string, label: string): FeatureSpec {
  return {
    id,
    label,
    nodeType: `solid.${id}`,
    operands: [
      { id: 'base', label: 'Base', type: 'geometry' },
      { id: 'tool', label: 'Tool', type: 'geometry' },
    ],
    numbers: [],
  };
}

function datumPlane(id: string, label: string): FeatureSpec {
  return { id, label, nodeType: `plane.${id}`, operands: [], numbers: [] };
}

/** Operand and number ids are the target node's input port ids, so building is generic. */
export const tabs: readonly FeatureTab[] = [
  {
    id: 'sketch',
    label: 'Sketch',
    groups: [
      {
        label: 'Create',
        features: [
          {
            id: 'sketch',
            label: 'Create Sketch',
            nodeType: 'sketch.constrained',
            kind: 'sketch',
            operands: [{ id: 'plane', label: 'Plane', type: 'plane' }],
            numbers: [],
          },
          {
            id: 'edit-sketch',
            label: 'Edit Sketch',
            nodeType: 'sketch.constrained',
            kind: 'edit',
            operands: [],
            numbers: [],
          },
          {
            id: 'rectangle',
            label: 'Rectangle',
            nodeType: 'sketch.rectangle',
            operands: [sketchPlane],
            numbers: [
              { id: 'width', label: 'Width', value: 40 },
              { id: 'height', label: 'Height', value: 25 },
              { id: 'u', label: 'U', value: 0 },
              { id: 'v', label: 'V', value: 0 },
            ],
          },
          {
            id: 'circle',
            label: 'Circle',
            nodeType: 'sketch.circle',
            operands: [sketchPlane],
            numbers: [
              { id: 'radius', label: 'Radius', value: 8 },
              { id: 'u', label: 'U', value: 0 },
              { id: 'v', label: 'V', value: 0 },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'solid',
    label: 'Solid',
    groups: [
      {
        label: 'Create',
        features: [
          {
            id: 'extrude',
            label: 'Extrude',
            nodeType: 'solid.extrude',
            operands: [
              { id: 'profile', label: 'Profile', type: 'sketch' },
              { id: 'target', label: 'Target body', type: 'geometry', optional: true },
            ],
            numbers: [{ id: 'distance', label: 'Distance', value: 10 }],
            choices: [
              {
                id: 'operation',
                label: 'Operation',
                options: EXTRUDE_OPERATIONS,
                value: 'New body',
              },
            ],
          },
        ],
      },
      {
        label: 'Modify',
        features: [
          {
            id: 'fillet',
            label: 'Fillet',
            nodeType: 'solid.fillet',
            operands: [{ id: 'solid', label: 'Edges', type: 'edges' }],
            numbers: [{ id: 'radius', label: 'Radius', value: 2 }],
          },
          {
            id: 'chamfer',
            label: 'Chamfer',
            nodeType: 'solid.chamfer',
            operands: [{ id: 'solid', label: 'Edges', type: 'edges' }],
            numbers: [{ id: 'distance', label: 'Distance', value: 2 }],
          },
          {
            id: 'shell',
            label: 'Shell',
            nodeType: 'solid.shell',
            operands: [{ id: 'solid', label: 'Open face', type: 'face' }],
            numbers: [{ id: 'thickness', label: 'Thickness', value: 2 }],
          },
          {
            id: 'move',
            label: 'Move',
            nodeType: 'solid.move',
            operands: [{ id: 'solid', label: 'Body', type: 'geometry' }],
            numbers: [
              { id: 'dx', label: 'X', value: 0 },
              { id: 'dy', label: 'Y', value: 0 },
              { id: 'dz', label: 'Z', value: 0 },
            ],
            splice: true,
          },
        ],
      },
      {
        label: 'Combine',
        features: [combine('cut', 'Cut'), combine('union', 'Union'), combine('intersect', 'Intersect')],
      },
      {
        label: 'Construct',
        features: [
          datumPlane('xy', 'XY Plane'),
          datumPlane('xz', 'XZ Plane'),
          datumPlane('yz', 'YZ Plane'),
          {
            id: 'offset',
            label: 'Offset Plane',
            nodeType: 'plane.offset',
            operands: [{ id: 'plane', label: 'Plane', type: 'plane' }],
            numbers: [{ id: 'distance', label: 'Distance', value: 10 }],
          },
        ],
      },
    ],
  },
];

export const features: readonly FeatureSpec[] = tabs.flatMap((tab) =>
  tab.groups.flatMap((group) => group.features),
);

/**
 * The dialog a node of this type was built by, where there is one.
 *
 * What makes a node reopenable is that a dialog knows how to say what it is:
 * its numbers, its choices and what it is built on. A sketch has a dialog of
 * its own kind — the drawing session — and is deliberately not offered here.
 */
export function specForNode(graph: Graph, nodeId: NodeId): FeatureSpec | null {
  const node = graph.getNode(nodeId);
  if (node === undefined) return null;
  return features.find((spec) => spec.nodeType === node.type && spec.kind === undefined) ?? null;
}

/** Where a plane came from: an existing node, or a face that needs a reference node. */
export type PlaneChoice =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'face'; nodeId: NodeId; normal: Vec3; rank: number };

/**
 * Turn a plane choice into a port, creating the face reference node when the
 * plane came from a picked face. Ids of anything created are appended to
 * `created` so a failed build can be rolled back.
 */
export function resolvePlaneSource(
  graph: Graph,
  choice: PlaneChoice,
  created: NodeId[],
): PortRef {
  if (choice.kind === 'node') {
    const port = outputPortFor(graph, choice.nodeId, 'plane');
    if (port === null) throw new Error('That node does not produce a plane');
    return port;
  }

  const source = outputPortFor(graph, choice.nodeId, 'geometry');
  if (source === null) throw new Error('A face reference needs a solid');

  const node = graph.addNode('face.plane', {
    inputs: {
      nx: choice.normal.x,
      ny: choice.normal.y,
      nz: choice.normal.z,
      rank: choice.rank,
    },
  });
  created.push(node.id);
  graph.connect(source, { node: node.id, port: 'solid' });
  placeDownstream(graph, node.id);

  return { node: node.id, port: 'plane' };
}

/**
 * An empty sketch on the chosen plane, ready to be drawn into.
 *
 * Nothing is inferred here: what ends up in it is what gets drawn, and the
 * session writes that to the node as it goes.
 */
export function createSketchNode(graph: Graph, source: PlaneChoice): NodeId {
  const created: NodeId[] = [];

  try {
    const plane = resolvePlaneSource(graph, source, created);
    const node = graph.addNode('sketch.constrained', {
      inputs: { points: [], entities: [], constraints: [], dims: [] },
    });
    created.push(node.id);

    graph.connect(plane, { node: node.id, port: 'plane' });
    placeDownstream(graph, node.id);
    return node.id;
  } catch (thrown) {
    for (const nodeId of created.reverse()) graph.removeNode(nodeId);
    throw thrown;
  }
}

/**
 * Put a set of picked edges into a node of their own, so the selection is
 * visible in the graph and can be re-pointed or shared later.
 */
export function resolveEdgeSource(
  graph: Graph,
  refs: readonly number[],
  created: NodeId[],
): PortRef {
  const node = graph.addNode('edge.selection', {
    inputs: { refs: [...refs] },
    label: `${refs.length / EDGE_STRIDE} edges`,
  });
  created.push(node.id);
  placeDownstream(graph, node.id);
  return { node: node.id, port: 'edges' };
}

/** The output port on `nodeId` that can drive an operand of the given type. */
export function outputPortFor(graph: Graph, nodeId: NodeId, type: DataType): PortRef | null {
  const node = graph.getNode(nodeId);
  if (node === null || node === undefined) return null;
  const schema = graph.schemaOf(nodeId);
  const port = schema.outputs.find((candidate) => candidate.type === type);
  return port === undefined ? null : { node: nodeId, port: port.id };
}

export function candidatesFor(
  graph: Graph,
  type: DataType,
  exclude: ReadonlySet<NodeId> = new Set(),
): Array<{ nodeId: NodeId; label: string }> {
  const results: Array<{ nodeId: NodeId; label: string }> = [];
  for (const node of graph.allNodes()) {
    if (exclude.has(node.id)) continue;
    const schema = graph.schemaOf(node.id);
    if (!schema.outputs.some((port) => port.type === type)) continue;
    results.push({ nodeId: node.id, label: node.label ?? schema.label });
  }
  return results;
}

function overlaps(
  a: { x: number; y: number; h: number },
  b: { x: number; y: number; h: number },
): boolean {
  return Math.abs(a.x - b.x) < NODE_WIDTH && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Place a new node one column right of its producers, nudged clear of neighbours. */
export function placeDownstream(graph: Graph, nodeId: NodeId): void {
  const height = nodeHeight(graph.schemaOf(nodeId));
  const sources = graph.incomingEdges(nodeId).map((edge) => graph.requireNode(edge.from.node));

  let x = 0;
  let y = 0;

  if (sources.length > 0) {
    x = Math.max(...sources.map((source) => source.position.x)) + NODE_WIDTH + COLUMN_GAP;
    y = Math.round(sources.reduce((sum, source) => sum + source.position.y, 0) / sources.length);
  } else {
    for (const node of graph.allNodes()) {
      if (node.id === nodeId) continue;
      x = Math.max(x, node.position.x);
    }
    x = graph.nodeCount > 1 ? x + NODE_WIDTH + COLUMN_GAP : 0;
  }

  const others = graph
    .allNodes()
    .filter((node) => node.id !== nodeId)
    .map((node) => ({
      x: node.position.x,
      y: node.position.y,
      h: nodeHeight(graph.schemaOf(node.id)),
    }));

  while (others.some((other) => overlaps({ x, y, h: height }, other))) {
    y += height + ROW_GAP;
  }

  graph.setPosition(nodeId, { x, y });
}

/**
 * The node standing for one of the three planes through the origin.
 *
 * Clicking a square in the view means "this plane", and a plane in this program
 * is a node — so one is made unless the document already has that plane, in
 * which case it is the one already there. A second XY Plane node would say
 * nothing the first does not.
 */
export function originPlaneNode(
  graph: Graph,
  axis: 'xy' | 'xz' | 'yz',
): { nodeId: NodeId; created: boolean } {
  const type = `plane.${axis}`;
  const existing = graph.allNodes().find((node) => node.type === type);
  if (existing !== undefined) return { nodeId: existing.id, created: false };

  const node = graph.addNode(type);
  placeDownstream(graph, node.id);
  return { nodeId: node.id, created: true };
}

export function buildFeature(
  graph: Graph,
  spec: FeatureSpec,
  operands: Record<string, PortRef>,
  numbers: Record<string, number | string>,
  /**
   * The point in the history being worked at, if the view is rolled back to
   * one. A feature built on that node goes in *there* rather than on the end,
   * which is what makes rolling back somewhere to work rather than to look.
   */
  spliceAt: NodeId | null = null,
): NodeId {
  const node = graph.addNode(spec.nodeType, { inputs: numbers });

  const first = spec.operands[0];
  const source = first === undefined ? undefined : operands[first.id];
  const atMarker = spliceAt !== null && source !== undefined && source.node === spliceAt;
  const into = spec.splice === true || atMarker ? first?.id : undefined;

  try {
    for (const [portId, source] of Object.entries(operands)) {
      // The spliced operand is not connected here: `spliceAfter` wires it, and
      // it refuses a node whose input is already spoken for.
      if (portId === into) continue;
      graph.connect(source, { node: node.id, port: portId });
    }

    if (into !== undefined) {
      if (source === undefined) throw new Error('There is nothing to splice this onto');
      spliceAfter(graph, source.node, node.id);
    }
  } catch (thrown) {
    graph.removeNode(node.id);
    throw thrown;
  }

  placeDownstream(graph, node.id);
  return node.id;
}
