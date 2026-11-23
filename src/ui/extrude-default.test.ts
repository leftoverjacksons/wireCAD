import { describe, expect, it } from 'vitest';
import { defaultExtrude } from './extrude-default.js';

const nothing = { overlaps: [], touches: [] };
const intoBlock = { overlaps: [{ nodeId: 'block', volume: 120 }], touches: [] };
const onBlock = { overlaps: [], touches: ['block'] };

describe('the default an extrude takes from what it meets', () => {
  it('is a new body when it meets nothing', () => {
    expect(defaultExtrude(nothing, {})).toMatchObject({ operation: 'New body', target: null });
  });

  it('cuts a body it runs into, and targets that body', () => {
    expect(defaultExtrude(intoBlock, {})).toMatchObject({ operation: 'Cut', target: 'block' });
  });

  it('joins a body it stands on without entering', () => {
    expect(defaultExtrude(onBlock, {})).toMatchObject({ operation: 'Join', target: 'block' });
  });

  it('cuts rather than joins when it stands on one body and runs into another', () => {
    const both = { overlaps: [{ nodeId: 'wall', volume: 5 }], touches: ['block'] };
    expect(defaultExtrude(both, {})).toMatchObject({ operation: 'Cut', target: 'wall' });
  });

  it('cuts the body it was sketched on before one it merely runs into further', () => {
    const two = {
      overlaps: [
        { nodeId: 'far', volume: 500 },
        { nodeId: 'block', volume: 20 },
      ],
      touches: [],
    };
    expect(defaultExtrude(two, {}, (id) => id === 'block').target).toBe('block');
    // Otherwise, the one it runs into most.
    expect(defaultExtrude(two, {}).target).toBe('far');
  });

  it('says why, whenever it decided something', () => {
    expect(defaultExtrude(intoBlock, {}, undefined, () => 'Bore').reason).toBe(
      'Cut, because it runs into Bore.',
    );
    expect(defaultExtrude(nothing, {}).reason).toBeNull();
  });
});

describe('what was set by hand', () => {
  it('keeps an operation chosen by hand, and finds it a target', () => {
    expect(defaultExtrude(intoBlock, { operation: 'Intersect' })).toMatchObject({
      operation: 'Intersect',
      target: 'block',
    });
    expect(defaultExtrude(onBlock, { operation: 'Cut' })).toMatchObject({
      operation: 'Cut',
      target: 'block',
    });
  });

  it('gives a hand-chosen new body no target', () => {
    expect(defaultExtrude(intoBlock, { operation: 'New body' })).toMatchObject({
      operation: 'New body',
      target: null,
    });
  });

  it('keeps a target chosen by hand, and follows it with the operation', () => {
    const both = { overlaps: [{ nodeId: 'wall', volume: 5 }], touches: ['block'] };
    expect(defaultExtrude(both, { target: 'block' })).toMatchObject({
      operation: 'Join',
      target: 'block',
    });
    expect(defaultExtrude(both, { target: 'wall' })).toMatchObject({
      operation: 'Cut',
      target: 'wall',
    });
  });

  it('takes "no target" by hand to mean a new body', () => {
    expect(defaultExtrude(intoBlock, { target: null })).toMatchObject({
      operation: 'New body',
      target: null,
    });
  });

  it('decides nothing once both have been set by hand', () => {
    expect(defaultExtrude(intoBlock, { operation: 'Join', target: 'other' })).toEqual({
      operation: 'Join',
      target: 'other',
      reason: null,
    });
  });
});
