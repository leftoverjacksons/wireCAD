import type { Graph } from '../core/graph.js';
import type { DataType, NodeId, PortRef } from '../core/types.js';
import { COLUMN_GAP, NODE_WIDTH, ROW_GAP, nodeHeight } from './metrics.js';

export interface OperandSpec {
  id: string;
  label: string;
  type: Extract<DataType, 'sketch' | 'geometry' | 'plane'>;
  /** Leaving it empty falls back to the node's declared port default. */
  optional?: boolean;
}

export interface NumberSpec {
  id: string;
  label: string;
  value: number;
}

export interface FeatureSpec {
  id: string;
  label: string;
  nodeType: string;
  operands: readonly OperandSpec[];
  numbers: readonly NumberSpec[];
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
            operands: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
            numbers: [{ id: 'distance', label: 'Distance', value: 10 }],
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

/** The output port on `nodeId` that can drive an operand of the given type. */
export function outputPortFor(graph: Graph, nodeId: NodeId, type: DataType): PortRef | null {
  const node = graph.getNode(nodeId);
  if (node === null || node === undefined) return null;
  const schema = graph.registry.require(node.type);
  const port = schema.outputs.find((candidate) => candidate.type === type);
  return port === undefined ? null : { node: nodeId, port: port.id };
}

export function candidatesFor(graph: Graph, type: DataType): Array<{ nodeId: NodeId; label: string }> {
  const results: Array<{ nodeId: NodeId; label: string }> = [];
  for (const node of graph.allNodes()) {
    const schema = graph.registry.require(node.type);
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
  const height = nodeHeight(graph.registry.require(graph.requireNode(nodeId).type));
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
      h: nodeHeight(graph.registry.require(node.type)),
    }));

  while (others.some((other) => overlaps({ x, y, h: height }, other))) {
    y += height + ROW_GAP;
  }

  graph.setPosition(nodeId, { x, y });
}

export function buildFeature(
  graph: Graph,
  spec: FeatureSpec,
  operands: Record<string, PortRef>,
  numbers: Record<string, number>,
): NodeId {
  const node = graph.addNode(spec.nodeType, { inputs: numbers });

  try {
    for (const [portId, source] of Object.entries(operands)) {
      graph.connect(source, { node: node.id, port: portId });
    }
  } catch (thrown) {
    graph.removeNode(node.id);
    throw thrown;
  }

  placeDownstream(graph, node.id);
  return node.id;
}
