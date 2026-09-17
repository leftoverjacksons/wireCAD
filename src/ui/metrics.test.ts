import { describe, expect, it } from 'vitest';
import type { NodeSchema } from '../core/types.js';
import { portLayout } from './metrics.js';

function schema(inputs: NodeSchema['inputs'], outputs: NodeSchema['outputs']): NodeSchema {
  return { type: 't', label: 'T', category: 'C', inputs, outputs };
}

const n = (id: string) => ({ id, label: id, type: 'number' as const });
const echo = (id: string) => ({ id, label: id, type: 'number' as const, echoes: id });

describe('port rows', () => {
  it('puts an echoed output on its own input row', () => {
    // A fillet: Solid, Edges, Radius in; Result plus an echoed Radius out.
    const layout = portLayout(
      schema(
        [
          { id: 'solid', label: 'Solid', type: 'geometry' },
          { id: 'edges', label: 'Edges', type: 'edges' },
          n('radius'),
        ],
        [{ id: 'result', label: 'Result', type: 'geometry' }, echo('radius')],
      ),
    );

    expect(layout.inputRow.get('radius')).toBe(2);
    expect(layout.outputRow.get('radius')).toBe(2);
    expect(layout.outputRow.get('result')).toBe(0);
    expect(layout.outputAt[1]).toBeUndefined();
    expect(layout.rows).toBe(3);
  });

  it('lines a profile up row for row', () => {
    const layout = portLayout(
      schema(
        [{ id: 'plane', label: 'Plane', type: 'plane' }, n('width'), n('height')],
        [{ id: 'profile', label: 'Profile', type: 'sketch' }, echo('width'), echo('height')],
      ),
    );

    for (const id of ['width', 'height']) {
      expect(layout.outputRow.get(id)).toBe(layout.inputRow.get(id));
    }
    expect(layout.rows).toBe(3);
  });

  it('moves a plain output aside rather than landing on a claimed row', () => {
    // Two real outputs, and an echo that wants the row the second would take.
    const layout = portLayout(
      schema([{ id: 'a', label: 'A', type: 'geometry' }, n('size')], [
        { id: 'first', label: 'First', type: 'geometry' },
        { id: 'second', label: 'Second', type: 'geometry' },
        echo('size'),
      ]),
    );

    expect(layout.outputRow.get('size')).toBe(1);
    expect(layout.outputRow.get('first')).toBe(0);
    expect(layout.outputRow.get('second')).toBe(2);
    expect(layout.rows).toBe(3);
  });

  it('grows the node when an echo sits below every other row', () => {
    const layout = portLayout(
      schema([{ id: 'a', label: 'A', type: 'geometry' }, n('x'), n('y')], [echo('y')]),
    );

    expect(layout.outputRow.get('y')).toBe(2);
    expect(layout.rows).toBe(3);
  });

  it('ignores an echo naming an input that is not there', () => {
    const layout = portLayout(
      schema([n('x')], [{ id: 'ghost', label: 'Ghost', type: 'number', echoes: 'missing' }]),
    );

    expect(layout.outputRow.get('ghost')).toBe(0);
    expect(layout.rows).toBe(1);
  });

  it('skips hidden ports entirely', () => {
    const layout = portLayout(
      schema(
        [{ id: 'points', label: 'Points', type: 'list', hidden: true }, n('x')],
        [echo('x')],
      ),
    );

    expect(layout.inputRow.get('x')).toBe(0);
    expect(layout.outputRow.get('x')).toBe(0);
    expect(layout.rows).toBe(1);
  });
});
