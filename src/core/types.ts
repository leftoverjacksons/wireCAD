export type NodeId = string;
export type EdgeId = string;
export type PortId = string;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Plain data, so it hashes, serializes and needs no disposal. */
export interface PlaneValue {
  readonly kind: 'plane';
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly xAxis: Vec3;
}

export interface GeometryRef {
  readonly kind: 'geometry';
  readonly handle: unknown;
  /** Present on profiles, so features built on them can follow the sketch plane. */
  readonly plane?: PlaneValue;
}

export type Value =
  | number
  | boolean
  | string
  | Vec3
  | PlaneValue
  | GeometryRef
  | Value[]
  | null;

export type DataType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'vector'
  | 'plane'
  | 'geometry'
  | 'sketch'
  | 'list'
  | 'edges'
  | 'any';

export interface PortDef {
  readonly id: PortId;
  readonly label: string;
  readonly type: DataType;
  readonly default?: Value;
}

/** Ports and presentation. The main thread knows this much without a kernel. */
export interface NodeSchema {
  readonly type: string;
  readonly label: string;
  readonly category: string;
  readonly inputs: readonly PortDef[];
  readonly outputs: readonly PortDef[];
}

export interface NodeDefinition extends NodeSchema {
  evaluate(inputs: Record<PortId, Value>): Record<PortId, Value>;
}

/** An unwired input port carries a literal in `inputs`; a wired one ignores it. */
export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  label?: string;
  position: { x: number; y: number };
  inputs: Record<PortId, Value>;
}

export interface PortRef {
  readonly node: NodeId;
  readonly port: PortId;
}

export interface Edge {
  readonly id: EdgeId;
  readonly from: PortRef;
  readonly to: PortRef;
}

export function isVec3(v: Value): v is Vec3 {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    'x' in v &&
    'y' in v &&
    'z' in v
  );
}

export function isPlane(v: Value): v is PlaneValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    'kind' in v &&
    (v as PlaneValue).kind === 'plane'
  );
}

export function typesCompatible(source: DataType, target: DataType): boolean {
  if (source === 'any' || target === 'any') return true;
  return source === target;
}
