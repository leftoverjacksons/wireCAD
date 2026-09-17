import type { NodeDefinition, NodeSchema, PortDef, Value } from '../core/types.js';
import { circleFace, polygonFace } from '../geometry/build.js';
import type { OpenCascadeInstance } from '../geometry/kernel.js';
import { geometry } from '../geometry/kernel.js';
import { WORLD_XY } from '../geometry/plane.js';
import { decodeSketch, dimensionsOf, loopOrder } from '../sketch/model.js';
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

      // One circle is a disc; otherwise the lines have to close into one loop.
      const only = model.entities[0];
      if (model.entities.length === 1 && only?.kind === 'circle') {
        const centre = result.points[only.centre]!;
        const radius = result.radii[0]!;
        if (radius <= 0) throw new Error('That circle solved to a radius of zero or less');
        return { profile: geometry(circleFace(oc, plane, radius, centre.u, centre.v), plane) };
      }

      const order = loopOrder(model);
      if (order === null) {
        throw new Error('A profile needs its lines to make exactly one closed loop');
      }

      const uv = order.flatMap((index) => {
        const point = result.points[index]!;
        return [point.u, point.v];
      });
      return { profile: geometry(polygonFace(oc, plane, uv), plane) };
    },
  };

  return [sketch];
}
