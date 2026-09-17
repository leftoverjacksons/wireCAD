import type { DataType, NodeSchema } from '../core/types.js';

/**
 * What a node produces, in the words someone modelling would use. The port
 * types already say this precisely; this says it at a glance, so a graph can be
 * read without tracing wires to work out which nodes are bodies.
 */
export interface NodeKind {
  /** Matches a `--type-*` custom property, so one palette drives everything. */
  type: DataType;
  label: string;
}

const KIND_LABELS: ReadonlyArray<{ type: DataType; label: string }> = [
  { type: 'geometry', label: 'Body' },
  { type: 'sketch', label: 'Profile' },
  { type: 'plane', label: 'Plane' },
  { type: 'edges', label: 'Edges' },
  { type: 'vector', label: 'Vector' },
  { type: 'list', label: 'List' },
  { type: 'number', label: 'Value' },
  { type: 'boolean', label: 'Flag' },
  { type: 'string', label: 'Text' },
];

/** The node's first output that names something recognisable. */
export function nodeKind(schema: NodeSchema): NodeKind | null {
  for (const candidate of KIND_LABELS) {
    if (schema.outputs.some((port) => port.type === candidate.type)) return candidate;
  }
  return null;
}
