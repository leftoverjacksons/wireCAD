import type { NodeDefinition } from '../core/types.js';
import { WORLD_XY, WORLD_XZ, WORLD_YZ, offsetPlane } from '../geometry/plane.js';
import { asNumber, asPlane } from './coerce.js';

function datum(type: string, label: string, plane: typeof WORLD_XY): NodeDefinition {
  return {
    type,
    label,
    category: 'Construct',
    inputs: [],
    outputs: [{ id: 'plane', label: 'Plane', type: 'plane' }],
    evaluate() {
      return { plane };
    },
  };
}

export const planeXY = datum('plane.xy', 'XY Plane', WORLD_XY);
export const planeXZ = datum('plane.xz', 'XZ Plane', WORLD_XZ);
export const planeYZ = datum('plane.yz', 'YZ Plane', WORLD_YZ);

export const planeOffset: NodeDefinition = {
  type: 'plane.offset',
  label: 'Offset Plane',
  category: 'Construct',
  inputs: [
    { id: 'plane', label: 'Plane', type: 'plane', default: WORLD_XY },
    { id: 'distance', label: 'Distance', type: 'number', default: 10 },
  ],
  outputs: [{ id: 'plane', label: 'Plane', type: 'plane' }],
  evaluate(inputs) {
    return {
      plane: offsetPlane(
        asPlane(inputs.plane ?? null, 'plane'),
        asNumber(inputs.distance ?? null, 'distance'),
      ),
    };
  },
};

export const planeNodes: readonly NodeDefinition[] = [planeXY, planeXZ, planeYZ, planeOffset];
