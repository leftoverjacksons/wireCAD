import type { NodeDefinition, NodeSchema } from '../core/types.js';
import { circleFace, polygonFace, rectangleFace } from '../geometry/build.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, geometryOf, kernelCall, shapeOf } from '../geometry/kernel.js';
import { WORLD_XY } from '../geometry/plane.js';
import { asList, asNumber, asPlane, asPositive } from './coerce.js';

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

/** A drawn sketch: a closed polygon as a flat list of U/V pairs on its plane. */
export const polygonSchema: NodeSchema = {
  type: 'sketch.polygon',
  label: 'Polygon',
  category: 'Sketch',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'points', label: 'Points', type: 'list', default: [] },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
};

export const extrudeSchema: NodeSchema = {
  type: 'solid.extrude',
  label: 'Extrude',
  category: 'Create',
  inputs: [
    { id: 'profile', label: 'Profile', type: 'sketch' },
    { id: 'distance', label: 'Distance', type: 'number', default: 10 },
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

      const uv = raw.map((value, index) => {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new Error(`Point value ${index} is not a number`);
        }
        return value;
      });

      return { profile: geometry(polygonFace(oc, plane, uv), plane) };
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
      return { solid: geometry(solid) };
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
