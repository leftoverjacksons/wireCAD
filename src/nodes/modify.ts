import type { NodeDefinition, NodeSchema, Vec3 } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, kernelCall, shapeOf, tessellate } from '../geometry/kernel.js';
import { length } from '../geometry/plane.js';
import { asNumber, asPositive } from './coerce.js';
import { matchingFaces } from './face.js';

export const filletSchema: NodeSchema = {
  type: 'solid.fillet',
  label: 'Fillet',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'radius', label: 'Radius', type: 'number', default: 2 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
};

export const shellSchema: NodeSchema = {
  type: 'solid.shell',
  label: 'Shell',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'thickness', label: 'Thickness', type: 'number', default: 2 },
    { id: 'nx', label: 'Open X', type: 'number', default: 0 },
    { id: 'ny', label: 'Open Y', type: 'number', default: 0 },
    { id: 'nz', label: 'Open Z', type: 'number', default: -1 },
    { id: 'rank', label: 'Rank', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
};

export const modifySchemas: readonly NodeSchema[] = [filletSchema, shellSchema];

export function createModifyNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  /** The explorer visits each edge once per adjoining face, so dedupe by identity. */
  function uniqueEdges(shape: Shape): Shape[] {
    const edges: Shape[] = [];
    const explorer = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );

    while (explorer.More()) {
      const edge = oc.TopoDS.Edge_1(explorer.Current());
      if (!edges.some((seen) => seen.IsSame(edge))) edges.push(edge);
      explorer.Next();
    }

    explorer.delete();
    return edges;
  }

  const fillet: NodeDefinition = {
    ...filletSchema,
    evaluate(inputs) {
      const shape = shapeOf(inputs.solid ?? null, 'solid');
      const radius = asPositive(inputs.radius ?? null, 'radius');

      const edges = uniqueEdges(shape);
      if (edges.length === 0) throw new Error('That shape has no edges to fillet');

      const maker = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
      for (const edge of edges) maker.Add_2(radius, edge);

      try {
        kernelCall('Fillet', `a radius of ${radius} mm is too large for these edges`, () =>
          maker.Build(),
        );
        if (!maker.IsDone()) {
          throw new Error(`Fillet of ${radius} mm does not fit on this shape`);
        }
        return { result: geometry(maker.Shape()) };
      } finally {
        maker.delete?.();
      }
    },
  };

  const shell: NodeDefinition = {
    ...shellSchema,
    evaluate(inputs) {
      const shape = shapeOf(inputs.solid ?? null, 'solid');
      const thickness = asPositive(inputs.thickness ?? null, 'thickness');

      const requested: Vec3 = {
        x: asNumber(inputs.nx ?? null, 'nx'),
        y: asNumber(inputs.ny ?? null, 'ny'),
        z: asNumber(inputs.nz ?? null, 'nz'),
      };
      const magnitude = length(requested);
      if (magnitude === 0) throw new Error('The opening direction must not be zero');

      const rank = asNumber(inputs.rank ?? null, 'rank');
      if (!Number.isInteger(rank) || rank < 0) {
        throw new Error(`Rank must be a non-negative integer, got ${rank}`);
      }

      // Same selector the face reference uses, so "the bottom" means the same
      // thing here as it does everywhere else.
      const { mesh, faceHandles } = tessellate(oc, shape, 1.0, 0.6);
      const normal: Vec3 = {
        x: requested.x / magnitude,
        y: requested.y / magnitude,
        z: requested.z / magnitude,
      };

      const matches = matchingFaces(mesh.faces, normal);
      const chosen = matches[rank];
      if (chosen === undefined) {
        throw new Error(
          matches.length === 0
            ? 'No planar face opens that way'
            : `Rank ${rank} is out of range: only ${matches.length} face(s) open that way`,
        );
      }

      const opening = faceHandles[mesh.faces.indexOf(chosen.face)];
      if (opening === undefined) throw new Error('Could not resolve the opening face');

      const removed = new oc.TopTools_ListOfShape_1();
      removed.Append_1(opening);

      const maker = new oc.BRepOffsetAPI_MakeThickSolid_1();
      try {
        const cause = `a ${thickness} mm wall does not fit, or this shape is too complex to hollow`;
        kernelCall('Shell', cause, () => {
          // A negative offset hollows inwards, leaving outside dimensions alone.
          maker.MakeThickSolidByJoin(
            shape,
            removed,
            -thickness,
            1.0e-3,
            oc.BRepOffset_Mode.BRepOffset_Skin,
            false,
            false,
            oc.GeomAbs_JoinType.GeomAbs_Arc,
            false,
          );
          maker.Build();
        });
        if (!maker.IsDone()) {
          throw new Error(`A wall of ${thickness} mm does not fit in this shape`);
        }
        return { result: geometry(maker.Shape()) };
      } finally {
        maker.delete?.();
        removed.delete?.();
      }
    },
  };

  return [fillet, shell];
}
