import { describe, expect, it } from 'vitest';
import type { Draft } from './draw.js';
import {
  addCircle,
  addLine,
  addPoint,
  addRectangle,
  removeParts,
  setConstruction,
  uniqueName,
} from './draw.js';
import { dimensionsOf } from './model.js';

function draft(): Draft {
  return { sketch: { points: [], entities: [], constraints: [] }, dimensions: new Map() };
}

describe('drawing', () => {
  it('anchors the first point so the sketch has somewhere to be', () => {
    const d = draft();
    addPoint(d, { u: 5, v: 7 }, 0.5);

    expect(d.sketch.constraints.map((rule) => rule.kind)).toEqual(['lockU', 'lockV']);
    expect(d.dimensions.get('originU')).toBe(5);
    expect(d.dimensions.get('originV')).toBe(7);
  });

  it('reuses a point already under the cursor, so edges join', () => {
    const d = draft();
    const first = addPoint(d, { u: 0, v: 0 }, 0.5);
    const again = addPoint(d, { u: 0.2, v: 0.1 }, 0.5);

    expect(again).toBe(first);
    expect(d.sketch.points).toHaveLength(1);
  });

  it('calls an edge drawn flat horizontal, and one drawn upright vertical', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    const c = addPoint(d, { u: 10, v: 8 }, 0.5);
    const diagonal = addPoint(d, { u: 3, v: 4 }, 0.5);

    addLine(d, a, b);
    addLine(d, b, c);
    addLine(d, c, diagonal);

    const drawn = d.sketch.constraints.filter(
      (rule) => rule.kind === 'horizontal' || rule.kind === 'vertical',
    );
    expect(drawn).toEqual([
      { kind: 'horizontal', line: 0 },
      { kind: 'vertical', line: 1 },
    ]);
  });

  it('gives a rectangle four edges and no lengths at all', () => {
    const d = draft();
    addRectangle(d, { u: 0, v: 0 }, { u: 40, v: 25 }, 0.5);

    expect(d.sketch.entities).toHaveLength(4);
    expect(d.sketch.points).toHaveLength(4);
    expect(dimensionsOf(d.sketch)).toEqual(['originU', 'originV']);
  });

  it('draws a construction line when asked for one, and an ordinary one otherwise', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 6 }, 0.5);
    const c = addPoint(d, { u: 20, v: 0 }, 0.5);

    addLine(d, a, b);
    addLine(d, b, c, true);

    expect(d.sketch.entities).toEqual([
      { kind: 'line', a: 0, b: 1 },
      { kind: 'line', a: 1, b: 2, construction: true },
    ]);
  });

  it('calls a construction line drawn flat horizontal, like any other', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    addLine(d, a, b, true);

    expect(d.sketch.constraints).toContainEqual({ kind: 'horizontal', line: 0 });
  });

  it('makes a rectangle of construction lines all the way round', () => {
    const d = draft();
    addRectangle(d, { u: 0, v: 0 }, { u: 40, v: 25 }, 0.5, true);

    expect(
      d.sketch.entities.every((entity) => entity.kind === 'line' && entity.construction === true),
    ).toBe(true);
  });

  it('turns a drawn line into construction and back without touching its rules', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    addLine(d, a, b);
    const rules = [...d.sketch.constraints];

    expect(setConstruction(d, [0], true)).toBe(1);
    expect(d.sketch.entities[0]).toEqual({ kind: 'line', a: 0, b: 1, construction: true });
    // Already construction: nothing to change, and nothing changed.
    expect(setConstruction(d, [0], true)).toBe(0);

    expect(setConstruction(d, [0], false)).toBe(1);
    expect(d.sketch.entities[0]).toEqual({ kind: 'line', a: 0, b: 1 });
    expect(d.sketch.constraints).toEqual(rules);
  });

  it('draws a construction circle when asked for one', () => {
    const d = draft();
    addCircle(d, { u: 0, v: 0 }, 5, 0.5, true);

    expect(d.sketch.entities[0]).toEqual({
      kind: 'circle',
      centre: 0,
      radius: 5,
      construction: true,
    });
  });

  it('turns a circle into construction and back, like anything else', () => {
    const d = draft();
    addCircle(d, { u: 0, v: 0 }, 5, 0.5);

    expect(setConstruction(d, [0], true)).toBe(1);
    expect(d.sketch.entities[0]).toEqual({
      kind: 'circle',
      centre: 0,
      radius: 5,
      construction: true,
    });
    expect(setConstruction(d, [0], false)).toBe(1);
    expect(d.sketch.entities[0]).toEqual({ kind: 'circle', centre: 0, radius: 5 });
  });

  it('keeps a line construction when something else is deleted from under it', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    const c = addPoint(d, { u: 10, v: 8 }, 0.5);
    addLine(d, a, b);
    addLine(d, b, c, true);

    removeParts(d, [0], []);

    expect(d.sketch.entities).toEqual([{ kind: 'line', a: 1, b: 2, construction: true }]);
  });

  it('will not draw an edge twice between the same two points', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);

    expect(addLine(d, a, b)).toBe(0);
    expect(addLine(d, b, a)).toBe(0);
    expect(d.sketch.entities).toHaveLength(1);
  });

  it('names each new dimension apart from the ones already there', () => {
    const dimensions = new Map([['length1', 10]]);
    expect(uniqueName(dimensions, 'length')).toBe('length2');
  });
});

describe('removeParts', () => {
  it('renumbers the rules that outlived what was deleted', () => {
    const d = draft();
    addRectangle(d, { u: 0, v: 0 }, { u: 40, v: 25 }, 0.5);
    const centre = addPoint(d, { u: 60, v: 12 }, 0.5);
    addCircle(d, { u: 60, v: 12 }, 5, 0.5);
    d.sketch.constraints.push({ kind: 'radius', circle: 4, dimension: 'radius1' });
    d.dimensions.set('radius1', 5);

    // Delete the first edge: the rules on the others have to follow them down.
    removeParts(d, [0], []);

    expect(d.sketch.entities).toHaveLength(4);
    const radius = d.sketch.constraints.find((rule) => rule.kind === 'radius');
    expect(radius).toMatchObject({ circle: 3 });
    expect(d.sketch.entities[3]).toMatchObject({ kind: 'circle', centre });
  });

  it('keeps a point an edge still needs', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    addLine(d, a, b);

    removeParts(d, [], [a, b]);
    expect(d.sketch.points).toHaveLength(2);
  });

  it('drops the dimensions whose rules have gone', () => {
    const d = draft();
    addCircle(d, { u: 0, v: 0 }, 5, 0.5);
    d.sketch.constraints.push({ kind: 'radius', circle: 0, dimension: 'radius1' });
    d.dimensions.set('radius1', 5);

    removeParts(d, [0], [0]);

    expect(d.sketch.entities).toHaveLength(0);
    expect(d.sketch.points).toHaveLength(0);
    expect([...d.dimensions.keys()]).toEqual([]);
  });

  it('anchors what is left when the anchor itself is deleted', () => {
    const d = draft();
    const a = addPoint(d, { u: 0, v: 0 }, 0.5);
    const b = addPoint(d, { u: 10, v: 0 }, 0.5);
    const c = addPoint(d, { u: 10, v: 10 }, 0.5);
    addLine(d, b, c);

    removeParts(d, [], [a]);

    expect(d.sketch.points).toHaveLength(2);
    expect(d.sketch.constraints.filter((rule) => rule.kind === 'lockU')).toMatchObject([
      { point: 0 },
    ]);
    expect(d.dimensions.get('originU')).toBe(10);
  });
});
