import type { NodeDefinition, NodeSchema } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, shapeOf } from '../geometry/kernel.js';
import { asNumber, asPositive } from './coerce.js';

export const rectangleSchema: NodeSchema = {
  type: 'sketch.rectangle',
  label: 'Rectangle',
  category: 'Sketch',
  inputs: [
    { id: 'width', label: 'Width', type: 'number', default: 40 },
    { id: 'depth', label: 'Depth', type: 'number', default: 25 },
    { id: 'x', label: 'X', type: 'number', default: 0 },
    { id: 'y', label: 'Y', type: 'number', default: 0 },
    { id: 'z', label: 'Z', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
};

export const circleSchema: NodeSchema = {
  type: 'sketch.circle',
  label: 'Circle',
  category: 'Sketch',
  inputs: [
    { id: 'radius', label: 'Radius', type: 'number', default: 8 },
    { id: 'x', label: 'X', type: 'number', default: 0 },
    { id: 'y', label: 'Y', type: 'number', default: 0 },
    { id: 'z', label: 'Z', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
};

export const extrudeSchema: NodeSchema = {
  type: 'solid.extrude',
  label: 'Extrude',
  category: 'Solid',
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
    category: 'Solid',
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

  function rectangleFace(width: number, depth: number, x: number, y: number, z: number): Shape {
    const corners: Array<[number, number]> = [
      [x, y],
      [x + width, y],
      [x + width, y + depth],
      [x, y + depth],
    ];

    const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
    for (let i = 0; i < corners.length; i++) {
      const from = corners[i]!;
      const to = corners[(i + 1) % corners.length]!;
      const p1 = new oc.gp_Pnt_3(from[0], from[1], z);
      const p2 = new oc.gp_Pnt_3(to[0], to[1], z);
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

  function circleFace(radius: number, x: number, y: number, z: number): Shape {
    const origin = new oc.gp_Pnt_3(x, y, z);
    const normal = new oc.gp_Dir_4(0, 0, 1);
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
      return {
        profile: geometry(
          rectangleFace(
            asPositive(inputs.width ?? null, 'width'),
            asPositive(inputs.depth ?? null, 'depth'),
            asNumber(inputs.x ?? null, 'x'),
            asNumber(inputs.y ?? null, 'y'),
            asNumber(inputs.z ?? null, 'z'),
          ),
        ),
      };
    },
  };

  const circle: NodeDefinition = {
    ...circleSchema,
    evaluate(inputs) {
      return {
        profile: geometry(
          circleFace(
            asPositive(inputs.radius ?? null, 'radius'),
            asNumber(inputs.x ?? null, 'x'),
            asNumber(inputs.y ?? null, 'y'),
            asNumber(inputs.z ?? null, 'z'),
          ),
        ),
      };
    },
  };

  const extrude: NodeDefinition = {
    ...extrudeSchema,
    evaluate(inputs) {
      const face = shapeOf(inputs.profile ?? null, 'profile');
      const distance = asNumber(inputs.distance ?? null, 'distance');
      if (distance === 0) throw new Error('Extrude distance must be non-zero');

      const direction = new oc.gp_Vec_4(0, 0, distance);
      const maker = new oc.BRepPrimAPI_MakePrism_1(face, direction, false, true);
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
