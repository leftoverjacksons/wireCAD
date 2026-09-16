import type { NodeDefinition, NodeSchema, PlaneValue } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, geometryOf, shapeOf } from '../geometry/kernel.js';
import { WORLD_XY, pointOnPlane } from '../geometry/plane.js';
import { asNumber, asPlane, asPositive } from './coerce.js';

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
  extrudeSchema,
  ...booleanOperations.map((operation) => operation.schema),
];

export function createGeometryNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  function faceFromWire(wire: Shape): Shape {
    const maker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!maker.IsDone()) {
      maker.delete();
      throw new Error('Profile does not bound a planar face');
    }
    const face = maker.Face();
    maker.delete();
    return face;
  }

  function rectangleFace(
    plane: PlaneValue,
    width: number,
    height: number,
    u: number,
    v: number,
  ): Shape {
    const corners = [
      pointOnPlane(plane, u, v),
      pointOnPlane(plane, u + width, v),
      pointOnPlane(plane, u + width, v + height),
      pointOnPlane(plane, u, v + height),
    ];

    const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
    for (let i = 0; i < corners.length; i++) {
      const from = corners[i]!;
      const to = corners[(i + 1) % corners.length]!;
      const p1 = new oc.gp_Pnt_3(from.x, from.y, from.z);
      const p2 = new oc.gp_Pnt_3(to.x, to.y, to.z);
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_3(p1, p2);
      wireMaker.Add_1(edgeMaker.Edge());
      edgeMaker.delete();
      p1.delete();
      p2.delete();
    }

    const wire = wireMaker.Wire();
    wireMaker.delete();
    return faceFromWire(wire);
  }

  function circleFace(plane: PlaneValue, radius: number, u: number, v: number): Shape {
    const centre = pointOnPlane(plane, u, v);

    const origin = new oc.gp_Pnt_3(centre.x, centre.y, centre.z);
    const normal = new oc.gp_Dir_4(plane.normal.x, plane.normal.y, plane.normal.z);
    const axis = new oc.gp_Ax2_3(origin, normal);
    const circle = new oc.gp_Circ_2(axis, radius);

    const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_8(circle);
    const wireMaker = new oc.BRepBuilderAPI_MakeWire_2(edgeMaker.Edge());
    const wire = wireMaker.Wire();

    wireMaker.delete();
    edgeMaker.delete();
    circle.delete();
    axis.delete();
    normal.delete();
    origin.delete();

    return faceFromWire(wire);
  }

  const rectangle: NodeDefinition = {
    ...rectangleSchema,
    evaluate(inputs) {
      const plane = asPlane(inputs.plane ?? null, 'plane');
      return {
        profile: geometry(
          rectangleFace(
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
      operation.Build();
      if (!operation.IsDone()) {
        operation.delete();
        throw new Error(`${schema.label} failed to build`);
      }
      const result = operation.Shape();
      operation.delete();
      return { result: geometry(result) };
    },
  }));

  return [rectangle, circle, extrude, ...booleans];
}
