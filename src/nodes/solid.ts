import type { NodeDefinition, NodeSchema, PortDef } from '../core/types.js';
import { circleFace, polygonFace, rectangleFace } from '../geometry/build.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, geometryOf, kernelCall, shapeOf } from '../geometry/kernel.js';
import { WORLD_XY } from '../geometry/plane.js';
import { asList, asNumber, asPlane, asPositive } from './coerce.js';

type ExtrudeOperation = (typeof EXTRUDE_OPERATIONS)[number];

function asOperation(value: unknown): ExtrudeOperation {
  if (value === null || value === undefined || value === '') return 'New body';
  if (typeof value !== 'string' || !EXTRUDE_OPERATIONS.includes(value as ExtrudeOperation)) {
    throw new Error(`Operation must be one of ${EXTRUDE_OPERATIONS.join(', ')}`);
  }
  return value as ExtrudeOperation;
}

export const rectangleSchema: NodeSchema = {
  type: 'sketch.rectangle',
  label: 'Rectangle',
  category: 'Sketch',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'width', label: 'Width', type: 'number', default: 40 },
    { id: 'height', label: 'Height', type: 'number', default: 25 },
    { id: 'u', label: 'U', type: 'number', default: 0 },
    { id: 'v', label: 'V', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
};

export const circleSchema: NodeSchema = {
  type: 'sketch.circle',
  label: 'Circle',
  category: 'Sketch',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'radius', label: 'Radius', type: 'number', default: 8 },
    { id: 'u', label: 'U', type: 'number', default: 0 },
    { id: 'v', label: 'V', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
};

/**
 * A drawn sketch. `points` holds the shape as drawn and is what decides how many
 * corners there are; each corner then gets its own named, wireable pair of
 * dimensions that default to the drawn value. Editing one, or driving it from a
 * parameter, overrides that corner without disturbing the rest.
 */
export const polygonSchema: NodeSchema = {
  type: 'sketch.polygon',
  label: 'Profile',
  category: 'Sketch',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'points', label: 'Points', type: 'list', default: [], hidden: true },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
  expand(inputs) {
    const drawn = Array.isArray(inputs.points) ? inputs.points : [];
    const corners = Math.floor(drawn.length / 2);

    const dimensions: PortDef[] = [];
    for (let corner = 0; corner < corners; corner++) {
      const u = drawn[corner * 2];
      const v = drawn[corner * 2 + 1];
      dimensions.push(
        { id: cornerPort(corner, 'u'), label: `P${corner + 1} U`, type: 'number', default: u ?? 0 },
        { id: cornerPort(corner, 'v'), label: `P${corner + 1} V`, type: 'number', default: v ?? 0 },
      );
    }

    // Echoed as outputs too, so one corner can drive something else without a
    // separate parameter node standing in the middle.
    return { inputs: dimensions, outputs: dimensions };
  },
};

export function cornerPort(corner: number, axis: 'u' | 'v'): string {
  return `p${corner + 1}${axis}`;
}

/** What an extrude does when it meets the body it is pointed at. */
export const EXTRUDE_OPERATIONS = ['New body', 'Join', 'Cut', 'Intersect'] as const;

export const extrudeSchema: NodeSchema = {
  type: 'solid.extrude',
  label: 'Extrude',
  category: 'Create',
  inputs: [
    { id: 'profile', label: 'Profile', type: 'sketch' },
    { id: 'distance', label: 'Distance', type: 'number', default: 10 },
    {
      id: 'operation',
      label: 'Operation',
      type: 'string',
      default: 'New body',
      options: EXTRUDE_OPERATIONS,
    },
    { id: 'target', label: 'Target', type: 'geometry' },
  ],
  outputs: [{ id: 'solid', label: 'Solid', type: 'geometry' }],
};

function booleanSchema(type: string, label: string): NodeSchema {
  return {
    type,
    label,
    category: 'Combine',
    inputs: [
      { id: 'base', label: 'Base', type: 'geometry' },
      { id: 'tool', label: 'Tool', type: 'geometry' },
    ],
    outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
  };
}

const booleanOperations = [
  { schema: booleanSchema('solid.cut', 'Cut'), constructor: 'BRepAlgoAPI_Cut_3' },
  { schema: booleanSchema('solid.union', 'Union'), constructor: 'BRepAlgoAPI_Fuse_3' },
  { schema: booleanSchema('solid.intersect', 'Intersect'), constructor: 'BRepAlgoAPI_Common_3' },
] as const;

export const geometrySchemas: readonly NodeSchema[] = [
  rectangleSchema,
  circleSchema,
  polygonSchema,
  extrudeSchema,
  ...booleanOperations.map((operation) => operation.schema),
];

export function createGeometryNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  const rectangle: NodeDefinition = {
    ...rectangleSchema,
    evaluate(inputs) {
      const plane = asPlane(inputs.plane ?? null, 'plane');
      return {
        profile: geometry(
          rectangleFace(
            oc,
            plane,
            asPositive(inputs.width ?? null, 'width'),
            asPositive(inputs.height ?? null, 'height'),
            asNumber(inputs.u ?? null, 'u'),
            asNumber(inputs.v ?? null, 'v'),
          ),
          plane,
        ),
      };
    },
  };

  const circle: NodeDefinition = {
    ...circleSchema,
    evaluate(inputs) {
      const plane = asPlane(inputs.plane ?? null, 'plane');
      return {
        profile: geometry(
          circleFace(
            oc,
            plane,
            asPositive(inputs.radius ?? null, 'radius'),
            asNumber(inputs.u ?? null, 'u'),
            asNumber(inputs.v ?? null, 'v'),
          ),
          plane,
        ),
      };
    },
  };

  const polygon: NodeDefinition = {
    ...polygonSchema,
    evaluate(inputs) {
      const plane = asPlane(inputs.plane ?? null, 'plane');
      const raw = asList(inputs.points ?? null, 'points');

      if (raw.length < 6) throw new Error('A profile needs at least three points');
      if (raw.length % 2 !== 0) throw new Error('Points must be pairs of U and V');

      // Each corner comes from its own port, which the schema defaulted to the
      // drawn value, so an untouched profile is exactly what was drawn.
      const corners = raw.length / 2;
      const uv: number[] = [];
      const outputs: Record<string, number> = {};
      for (let corner = 0; corner < corners; corner++) {
        for (const axis of ['u', 'v'] as const) {
          const portId = cornerPort(corner, axis);
          const value = inputs[portId];
          if (typeof value !== 'number' || Number.isNaN(value)) {
            throw new Error(`P${corner + 1} ${axis.toUpperCase()} is not a number`);
          }
          uv.push(value);
          outputs[portId] = value;
        }
      }

      return { ...outputs, profile: geometry(polygonFace(oc, plane, uv), plane) };
    },
  };

  const extrude: NodeDefinition = {
    ...extrudeSchema,
    evaluate(inputs) {
      const profile = geometryOf(inputs.profile ?? null, 'profile');
      const distance = asNumber(inputs.distance ?? null, 'distance');
      if (distance === 0) throw new Error('Extrude distance must be non-zero');

      // Follow the sketch plane, the way a CAD extrude defaults to the profile normal.
      const normal = profile.plane?.normal ?? { x: 0, y: 0, z: 1 };
      const direction = new oc.gp_Vec_4(
        normal.x * distance,
        normal.y * distance,
        normal.z * distance,
      );
      const maker = new oc.BRepPrimAPI_MakePrism_1(profile.handle as Shape, direction, false, true);
      const solid = maker.Shape();
      maker.delete();
      direction.delete();

      const operation = asOperation(inputs.operation ?? null);
      if (operation === 'New body') return { solid: geometry(solid) };

      // Cutting a bore is the same feature as raising a boss, pointed the other
      // way, so the combine lives here rather than in a node of its own.
      const target = inputs.target ?? null;
      if (target === null) {
        throw new Error(`${operation} needs a target body — wire one into Target`);
      }

      const constructors = {
        Join: 'BRepAlgoAPI_Fuse_3',
        Cut: 'BRepAlgoAPI_Cut_3',
        Intersect: 'BRepAlgoAPI_Common_3',
      } as const;

      const combine = new oc[constructors[operation]](shapeOf(target, 'target'), solid);
      kernelCall(operation, 'this shape cannot be combined with the target', () => combine.Build());
      if (!combine.IsDone()) {
        combine.delete?.();
        throw new Error(`${operation} failed to build`);
      }
      const result = combine.Shape();
      combine.delete?.();
      return { solid: geometry(result) };
    },
  };

  const booleans: NodeDefinition[] = booleanOperations.map(({ schema, constructor }) => ({
    ...schema,
    evaluate(inputs) {
      const base = shapeOf(inputs.base ?? null, 'base');
      const tool = shapeOf(inputs.tool ?? null, 'tool');

      const operation = new oc[constructor](base, tool);
      kernelCall(schema.label, 'these two shapes cannot be combined', () => operation.Build());
      if (!operation.IsDone()) {
        operation.delete();
        throw new Error(`${schema.label} failed to build`);
      }
      const result = operation.Shape();
      operation.delete();
      return { result: geometry(result) };
    },
  }));

  return [rectangle, circle, polygon, extrude, ...booleans];
}
