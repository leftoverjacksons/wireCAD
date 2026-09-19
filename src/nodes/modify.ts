import type { NodeDefinition, NodeSchema, Vec3 } from '../core/types.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry, kernelCall, shapeOf, tessellate } from '../geometry/kernel.js';
import { length } from '../geometry/plane.js';
import { asNumber, asPositive } from './coerce.js';
import { echoDimensions } from './echo.js';
import { matchFaceRef } from './faceref.js';
import { readEdgeRefs, resolveEdgeRefs } from './edges.js';
import { matchingFaces } from './face.js';

export const filletSchema: NodeSchema = echoDimensions({
  type: 'solid.fillet',
  label: 'Fillet',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'edges', label: 'Edges', type: 'edges', default: [] },
    { id: 'radius', label: 'Radius', type: 'number', default: 2 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
});

export const chamferSchema: NodeSchema = echoDimensions({
  type: 'solid.chamfer',
  label: 'Chamfer',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'edges', label: 'Edges', type: 'edges', default: [] },
    { id: 'distance', label: 'Distance', type: 'number', default: 2 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
});

export const shellSchema: NodeSchema = echoDimensions({
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
});

/**
 * Translation, and only translation.
 *
 * A rigid translation is the one transform this program's way of naming
 * topology survives untouched: edges are matched by their fraction of the
 * body's bounding box and faces by normal and rank, and moving a body changes
 * neither. Rotation changes both, and wants its own thinking before it is
 * offered.
 */
export const moveSchema: NodeSchema = echoDimensions({
  type: 'solid.move',
  label: 'Move',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'dx', label: 'X', type: 'number', default: 0 },
    { id: 'dy', label: 'Y', type: 'number', default: 0 },
    { id: 'dz', label: 'Z', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
});

/**
 * Taking a face off a body and healing what is left into a solid again.
 *
 * Not punching a hole: that would leave an open shell, which cannot be
 * booleaned or exported as a body. The kernel's own defeaturing removes the
 * face and joins its neighbours over the gap, which is what "delete this bore"
 * or "delete this rounding" actually means.
 *
 * The face is named by where it sits rather than by which way it points,
 * because the faces most worth deleting — a bore, a rounding — have no single
 * normal to be named by.
 */
export const defeatureSchema: NodeSchema = echoDimensions({
  type: 'solid.defeature',
  label: 'Delete Face',
  category: 'Modify',
  inputs: [
    { id: 'solid', label: 'Solid', type: 'geometry' },
    { id: 'fx', label: 'Face X', type: 'number', default: 0.5 },
    { id: 'fy', label: 'Face Y', type: 'number', default: 0.5 },
    { id: 'fz', label: 'Face Z', type: 'number', default: 0.5 },
    { id: 'area', label: 'Area', type: 'number', default: 0 },
  ],
  outputs: [{ id: 'result', label: 'Result', type: 'geometry' }],
});

export const modifySchemas: readonly NodeSchema[] = [
  filletSchema,
  chamferSchema,
  shellSchema,
  moveSchema,
  defeatureSchema,
];

export function createModifyNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  const SKIN = () => oc.BRepOffset_Mode.BRepOffset_Skin;
  const ARC = () => oc.GeomAbs_JoinType.GeomAbs_Arc;

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

  function countSubShapes(shape: Shape, kind: unknown): number {
    let total = 0;
    const explorer = new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (explorer.More()) {
      total += 1;
      explorer.Next();
    }
    explorer.delete();
    return total;
  }

  function volumeOf(shape: Shape): number {
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, false, false, false);
    const mass = props.Mass();
    props.delete?.();
    return mass;
  }

  function cut(base: Shape, tool: Shape, what: string): Shape {
    const operation = new oc.BRepAlgoAPI_Cut_3(base, tool);
    kernelCall('Shell', what, () => operation.Build());
    if (!operation.IsDone()) {
      operation.delete?.();
      throw new Error(`Shell failed — could not ${what}`);
    }
    const result = operation.Shape();
    operation.delete?.();
    return result;
  }

  /**
   * The face the shell opens through, named by direction and rank rather than
   * index, so "the bottom" means the same thing here as it does everywhere else.
   */
  function openingFace(shape: Shape, normal: Vec3, rank: number): Shape {
    const { mesh, faceHandles } = tessellate(oc, shape, 1.0, 0.6);
    const matches = matchingFaces(mesh.faces, normal);
    const chosen = matches[rank];
    if (chosen === undefined) {
      throw new Error(
        matches.length === 0
          ? 'No planar face opens that way'
          : `Rank ${rank} is out of range: only ${matches.length} face(s) open that way`,
      );
    }

    const handle = faceHandles[mesh.faces.indexOf(chosen.face)];
    if (handle === undefined) throw new Error('Could not resolve the opening face');
    return handle;
  }

  /** A negative offset hollows inwards, leaving the outside dimensions alone. */
  function offsetInward(shape: Shape, thickness: number): Shape {
    const maker = new oc.BRepOffsetAPI_MakeOffsetShape_1();
    const cause = `a ${thickness} mm wall does not fit inside this shape`;
    kernelCall('Shell', cause, () => {
      maker.PerformByJoin(shape, -thickness, 1.0e-3, SKIN(), false, false, ARC(), false);
      maker.Build();
    });
    if (!maker.IsDone()) throw new Error(`A wall of ${thickness} mm does not fit in this shape`);
    return maker.Shape();
  }

  /**
   * Measured against this build: on a filleted body the offset returns a bare
   * TopoDS_Shell rather than a solid, and booleans quietly refuse a shell. Worse,
   * when the wall is at least as thick as the smallest fillet radius — so the
   * inner radius would be zero or negative — it still reports success while
   * returning several disconnected open shells enclosing no volume. Both cases
   * have to be caught here; neither raises on its own.
   */
  function closeOffset(offset: Shape, thickness: number): Shape {
    const shells = countSubShapes(offset, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    if (shells !== 1) {
      throw new Error(
        `A wall of ${thickness} mm is too thick to hollow this shape — ` +
          'every fillet radius must be larger than the wall thickness',
      );
    }

    let solid = offset;
    if (countSubShapes(offset, oc.TopAbs_ShapeEnum.TopAbs_SOLID) === 0) {
      const explorer = new oc.TopExp_Explorer_2(
        offset,
        oc.TopAbs_ShapeEnum.TopAbs_SHELL,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      );
      const maker = new oc.BRepBuilderAPI_MakeSolid_3(oc.TopoDS.Shell_1(explorer.Current()));
      explorer.delete();
      kernelCall('Shell', 'close the hollowed interior', () => maker.Build());
      if (!maker.IsDone()) throw new Error('Shell failed — the hollowed interior would not close');
      solid = maker.Solid();
      // Built from a loose shell, the solid can come out inside-out.
      oc.BRepLib.OrientClosedSolid(solid);
    }

    if (!(volumeOf(solid) > 0)) {
      throw new Error(`A wall of ${thickness} mm leaves no interior to hollow`);
    }
    return solid;
  }

  /**
   * Fillet and chamfer differ only in which maker runs; both take one amount per
   * edge through `Add_2`, and both are driven by the same edge selection.
   */
  /**
   * The faces the operation put where those edges were.
   *
   * The kernel knows exactly: each edge given to a fillet or a chamfer reports
   * what it generated. Working it out afterwards by comparing the result with
   * what went in would also catch the faces that were merely trimmed, which are
   * not what the feature is responsible for.
   */
  function facesMadeFrom(maker: Shape, edges: readonly Shape[]): Shape[] {
    const made: Shape[] = [];

    for (const edge of edges) {
      // The list cannot be iterated directly in this build, so it is emptied.
      const remaining = new oc.TopTools_ListOfShape_1();
      remaining.Assign(maker.Generated(edge));
      while (remaining.Size() > 0) {
        // First() hands back a reference into the list, which the removal on
        // the next line frees. Reversed() is a copy by value and so outlives
        // it, and IsSame weighs shape and place but not which way round a face
        // is, so the copy still answers to the face it came from.
        const face = remaining.First_1().Reversed() as Shape;
        if (made.some((seen) => seen.IsSame(face))) face.delete?.();
        else made.push(face);
        remaining.RemoveFirst();
      }
      remaining.delete?.();
    }

    return made;
  }

  function edgeFeature(
    schema: NodeSchema,
    amountPort: string,
    makeBuilder: (shape: Shape) => Shape,
  ): NodeDefinition {
    return {
      ...schema,
      evaluate(inputs) {
        const shape = shapeOf(inputs.solid ?? null, 'solid');
        const amount = asPositive(inputs[amountPort] ?? null, amountPort);

        // An empty selection takes every edge, which is what these nodes did
        // before selections existed.
        const selection = readEdgeRefs(inputs.edges ?? [], 'edges');
        const edges =
          selection.length === 0 ? uniqueEdges(shape) : resolveEdgeRefs(oc, shape, selection);
        if (edges.length === 0) {
          throw new Error(`That shape has no edges to ${schema.label.toLowerCase()}`);
        }

        const maker = makeBuilder(shape);
        for (const edge of edges) maker.Add_2(amount, edge);

        try {
          // An amount that does not fit aborts inside the kernel rather than
          // reporting, so the guard is what turns it into something readable.
          const cause = `${amount} mm is too large for ${
            edges.length === 1 ? 'that edge' : 'these edges'
          }`;
          kernelCall(schema.label, cause, () => maker.Build());
          if (!maker.IsDone()) {
            throw new Error(`${schema.label} of ${amount} mm does not fit on this shape`);
          }
          return { result: geometry(maker.Shape(), undefined, facesMadeFrom(maker, edges)) };
        } finally {
          maker.delete?.();
        }
      },
    };
  }

  const fillet = edgeFeature(
    filletSchema,
    'radius',
    (shape) =>
      new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational) as Shape,
  );

  const chamfer = edgeFeature(
    chamferSchema,
    'distance',
    (shape) => new oc.BRepFilletAPI_MakeChamfer(shape) as Shape,
  );

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

      const normal: Vec3 = {
        x: requested.x / magnitude,
        y: requested.y / magnitude,
        z: requested.z / magnitude,
      };

      // The kernel's own one-shot hollow. Cleaner topology when it works, but on
      // a filleted body it reaches code this WASM build cannot run, so failure
      // here is expected rather than exceptional — fall through and model it.
      const opening = openingFace(shape, normal, rank);
      const removed = new oc.TopTools_ListOfShape_1();
      removed.Append_1(opening);
      const maker = new oc.BRepOffsetAPI_MakeThickSolid_1();
      try {
        const cause = `a ${thickness} mm wall does not fit in this shape`;
        kernelCall('Shell', cause, () => {
          maker.MakeThickSolidByJoin(
            shape,
            removed,
            -thickness,
            1.0e-3,
            SKIN(),
            false,
            false,
            ARC(),
            false,
          );
          maker.Build();
        });
        if (maker.IsDone()) return { result: geometry(maker.Shape()) };
      } catch {
        // Handled below by the modelled path.
      } finally {
        maker.delete?.();
        removed.delete?.();
      }

      // Hollow by construction instead: offset the body inward for the cavity,
      // subtract it, then remove the wall over the opening by sweeping the
      // cavity's own opening face back out. Uniform wall thickness by definition,
      // and every step of it works on filleted input.
      const inner = closeOffset(offsetInward(shape, thickness), thickness);
      const cavity = cut(shape, inner, 'hollow this shape');
      const push = new oc.gp_Vec_4(
        normal.x * thickness,
        normal.y * thickness,
        normal.z * thickness,
      );
      const plug = new oc.BRepPrimAPI_MakePrism_1(
        openingFace(inner, normal, rank),
        push,
        false,
        true,
      ).Shape();
      push.delete?.();
      return { result: geometry(cut(cavity, plug, 'open the shell')) };
    },
  };

  const move: NodeDefinition = {
    ...moveSchema,
    evaluate: (inputs) => {
      const shape = shapeOf(inputs.solid ?? null, 'solid');
      const dx = asNumber(inputs.dx ?? null, 'dx');
      const dy = asNumber(inputs.dy ?? null, 'dy');
      const dz = asNumber(inputs.dz ?? null, 'dz');

      const trsf = new oc.gp_Trsf_1();
      const vector = new oc.gp_Vec_4(dx, dy, dz);
      trsf.SetTranslation_1(vector);

      // Copied rather than moved in place, even for a translation of nothing:
      // handing the input's own handle back would give one shape two owners,
      // and the second to be evicted from the cache would free it twice.
      const maker = new oc.BRepBuilderAPI_Transform_2(shape, trsf, true);
      const moved = kernelCall('Move', 'this shape could not be moved', () => {
        if (!maker.IsDone()) throw new Error('the kernel did not finish the transform');
        return maker.Shape();
      });

      vector.delete?.();
      trsf.delete?.();
      maker.delete?.();
      return { result: geometry(moved) };
    },
  };

  const defeature: NodeDefinition = {
    ...defeatureSchema,
    evaluate: (inputs) => {
      const shape = shapeOf(inputs.solid ?? null, 'solid');
      const ref = {
        fx: asNumber(inputs.fx ?? null, 'fx'),
        fy: asNumber(inputs.fy ?? null, 'fy'),
        fz: asNumber(inputs.fz ?? null, 'fz'),
        area: asNumber(inputs.area ?? null, 'area'),
      };

      const { mesh, faceHandles } = tessellate(oc, shape, 1.0, 0.6);
      const index = matchFaceRef(mesh.faces, ref);
      const face = index < 0 ? undefined : faceHandles[index];
      if (face === undefined) {
        throw new Error('That face is not on this body any more');
      }

      const before = countSubShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE);
      const maker = new oc.BRepAlgoAPI_Defeaturing();
      maker.SetShape(shape);
      maker.AddFaceToRemove(face);
      kernelCall('Delete Face', 'that face cannot be removed on its own', () => maker.Build());
      if (!maker.IsDone()) throw new Error('Delete Face failed — the kernel gave up on it');

      const result = maker.Shape();
      // It reports success either way: a face it cannot remove comes back as
      // the body unchanged rather than as an error. Counting faces is how the
      // difference between "removed it" and "did nothing" is actually known.
      if (countSubShapes(result, oc.TopAbs_ShapeEnum.TopAbs_FACE) >= before) {
        throw new Error(
          'That face cannot be removed on its own — there is nothing to heal the gap with',
        );
      }

      maker.delete?.();
      return { result: geometry(result) };
    },
  };

  return [fillet, chamfer, shell, move, defeature];
}
