import type { NodeSchema, PortDef } from '../core/types.js';

/**
 * Offer every dimension a node holds as an output as well as an input, so one
 * can drive another without a parameter node standing in between.
 *
 * Echoed outputs follow the order of the inputs they come from, which lines them
 * up with their own rows on nodes whose other outputs are few — a profile reads
 * across as Width in, Width out. A dropdown or a wired-in-only port is not a
 * dimension and is left alone.
 */
export function echoDimensions(schema: NodeSchema): NodeSchema {
  const echoed: PortDef[] = [];
  for (const port of schema.inputs) {
    if (port.type !== 'number' || port.hidden === true || port.options !== undefined) continue;
    if (schema.outputs.some((existing) => existing.id === port.id)) continue;
    echoed.push({ id: port.id, label: port.label, type: 'number', echoes: port.id });
  }

  if (echoed.length === 0) return schema;
  return { ...schema, outputs: [...schema.outputs, ...echoed] };
}
