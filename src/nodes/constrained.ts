import type { NodeDefinition, NodeSchema, PortDef, Value } from '../core/types.js';
import { circleWire, compoundOf, faceWithHoles, wireFromPoints } from '../geometry/build.js';
import type { OpenCascadeInstance, Shape } from '../geometry/kernel.js';
import { geometry } from '../geometry/kernel.js';
import { WORLD_XY, pointOnPlane } from '../geometry/plane.js';
import { decodeSketch, dimensionsOf } from '../sketch/model.js';
import type { Region } from '../sketch/regions.js';
import { nestRegions, regionsOf, signedArea } from '../sketch/regions.js';
import { solveSketch } from '../sketch/solver.js';
import { asPlane } from './coerce.js';

/** Alternating name and value: the dimensions the sketch was drawn with. */
function storedDimensions(value: Value | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(value)) return out;
  for (let i = 0; i + 1 < value.length; i += 2) {
    const name = value[i];
    const number = value[i + 1];
    if (typeof name === 'string' && typeof number === 'number') out.set(name, number);
  }
  return out;
}

/**
 * A sketch that holds its own rules. The shape is whatever satisfies them, so
 * the node's dimensions are the handles: each one the sketch names becomes a
 * port, editable in place or driven from elsewhere, and the solver decides where
 * the geometry ends up.
 */
export const constrainedSchema: NodeSchema = {
  type: 'sketch.constrained',
  label: 'Sketch',
  category: 'Sketch',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'points', label: 'Points', type: 'list', default: [], hidden: true },
    { id: 'entities', label: 'Entities', type: 'list', default: [], hidden: true },
    { id: 'constraints', label: 'Constraints', type: 'list', default: [], hidden: true },
    { id: 'dims', label: 'Dimensions', type: 'list', default: [], hidden: true },
  ],
  outputs: [{ id: 'profile', label: 'Profile', type: 'sketch' }],
  expand(inputs) {
    let names: string[] = [];
    try {
      names = dimensionsOf(
        decodeSketch(inputs.points ?? [], inputs.entities ?? [], inputs.constraints ?? []),
      );
    } catch {
      // A malformed sketch grows no ports; evaluating it reports why.
      return {};
    }

    const stored = storedDimensions(inputs.dims);
    const ports: PortDef[] = names.map((name) => ({
      id: dimensionPort(name),
      label: name,
      type: 'number',
      default: stored.get(name) ?? 0,
    }));

    return { inputs: ports, outputs: ports.map((port) => ({ ...port, echoes: port.id })) };
  },
};

/** Namespaced so a dimension called "plane" cannot collide with the plane port. */
export function dimensionPort(name: string): string {
  return `d_${name}`;
}

export const constrainedSchemas: readonly NodeSchema[] = [constrainedSchema];

export function createConstrainedNodes(oc: OpenCascadeInstance): NodeDefinition[] {
  const sketch: NodeDefinition = {
    ...constrainedSchema,
    evaluate(inputs) {
      const plane = asPlane(inputs.plane ?? null, 'plane');
      const model = decodeSketch(
        inputs.points ?? [],
        inputs.entities ?? [],
        inputs.constraints ?? [],
      );

      const dimensions = new Map<string, number>();
      for (const name of dimensionsOf(model)) {
        const value = inputs[dimensionPort(name)];
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new Error(`Dimension "${name}" is not a number`);
        }
        dimensions.set(name, value);
      }

      const result = solveSketch(model, dimensions);
      if (!result.solved) {
        throw new Error(
          `These constraints cannot all hold at once — off by ${result.worst.toFixed(3)} mm. ` +
            'Check for a dimension fighting a relation.',
        );
      }

      // Whatever the sketch closes around becomes material, and whatever is
      // drawn inside that becomes a hole in it. One sketch can hold as many of
      // both as it likes; nesting decides which is which, not drawing order.
      const regions = regionsOf(model);
      if (regions.length === 0) {
        throw new Error('This sketch has nothing closed in it yet — draw a loop or a circle');
      }

      // A wire bounds material when it runs anticlockwise and takes it away
      // when it runs clockwise. Which way a loop was drawn says nothing about
      // which it is meant to be, so each one is turned to suit its part.
      const wireOf = (region: Region, hole: boolean): Shape => {
        if (region.kind === 'circle') {
          const centre = result.points[region.centre]!;
          const radius = result.radii[region.entity]!;
          if (radius <= 0) throw new Error('A circle here solved to a radius of zero or less');
          const wire = circleWire(oc, plane, radius, centre.u, centre.v);
          return hole ? oc.TopoDS.Wire_1(wire.Reversed()) : wire;
        }

        const uv = region.points.map((index) => result.points[index]!);
        if (signedArea(uv) < 0 !== hole) uv.reverse();
        return wireFromPoints(
          oc,
          uv.map((point) => pointOnPlane(plane, point.u, point.v)),
        );
      };

      const faces = nestRegions(regions, result.points, result.radii).map((face) =>
        faceWithHoles(
          oc,
          wireOf(regions[face.outer]!, false),
          face.holes.map((hole) => wireOf(regions[hole]!, true)),
        ),
      );

      return { profile: geometry(compoundOf(oc, faces), plane) };
    },
  };

  return [sketch];
}
