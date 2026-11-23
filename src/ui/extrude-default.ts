import type { NodeId } from '../core/types.js';

/**
 * Which way an extrude should default, from what it would run into.
 *
 * Kept apart from the dialog and the kernel so the rule itself can be read and
 * tested: the kernel says what the bare prism overlaps and what it rests
 * against, and this says what that means for Operation and Target.
 */

/** What the bare prism does to each body on screen, as the worker measured it. */
export interface ExtrudeContact {
  /** Bodies the prism runs into, with how much volume it shares with each. */
  overlaps: ReadonlyArray<{ nodeId: NodeId; volume: number }>;
  /** Bodies it lies against without entering. */
  touches: readonly NodeId[];
}

/**
 * What the person has said for themselves. A field left undefined is the
 * dialog's to decide; a target of null is somebody saying "no target".
 */
export interface Stipulated {
  operation?: string;
  target?: NodeId | null;
}

export interface ExtrudeDefault {
  operation: string;
  target: NodeId | null;
  /** Said in the dialog, so a choice nobody made is never a silent one. */
  reason: string | null;
}

/**
 * The body a list most likely means. The one the sketch was drawn on comes
 * first, since that is the body the feature is about; after that, among bodies
 * run into, the one run into most.
 */
function pick(
  ids: readonly NodeId[],
  prefers: (nodeId: NodeId) => boolean,
): NodeId | null {
  return ids.find(prefers) ?? ids[0] ?? null;
}

export function defaultExtrude(
  contact: ExtrudeContact,
  stipulated: Stipulated,
  prefers: (nodeId: NodeId) => boolean = () => false,
  describe: (nodeId: NodeId) => string = (nodeId) => nodeId,
): ExtrudeDefault {
  const overlapping = [...contact.overlaps]
    .sort((a, b) => b.volume - a.volume)
    .map((entry) => entry.nodeId);
  const runsInto = pick(overlapping, prefers);
  const restsOn = pick(contact.touches, prefers);
  const overlaps = (nodeId: NodeId): boolean => overlapping.includes(nodeId);

  // A target said by hand stands. Only the operation is left to choose, and
  // it follows what the extrusion does to that body.
  if (stipulated.target !== undefined) {
    const target = stipulated.target;
    if (stipulated.operation !== undefined) {
      return { operation: stipulated.operation, target, reason: null };
    }
    if (target === null) return { operation: 'New body', target: null, reason: null };
    return overlaps(target)
      ? { operation: 'Cut', target, reason: `Cut, because it runs into ${describe(target)}.` }
      : { operation: 'Join', target, reason: `Join, onto ${describe(target)}.` };
  }

  // An operation said by hand stands. The target is whichever body it most
  // plausibly means: the one the sketch is on, if the extrusion meets it.
  if (stipulated.operation !== undefined) {
    const operation = stipulated.operation;
    if (operation === 'New body') return { operation, target: null, reason: null };

    const met = [...overlapping, ...contact.touches];
    const target =
      met.find(prefers) ??
      (operation === 'Join' ? (restsOn ?? runsInto) : (runsInto ?? restsOn));
    return {
      operation,
      target,
      reason: target === null ? null : `${operation} with ${describe(target)}, which it meets.`,
    };
  }

  // Neither: the geometry decides both. Running into a body outranks resting
  // on one, because an extrusion that enters a body and is left a new body is
  // two solids occupying the same space — never what was meant.
  if (runsInto !== null) {
    return {
      operation: 'Cut',
      target: runsInto,
      reason: `Cut, because it runs into ${describe(runsInto)}.`,
    };
  }
  if (restsOn !== null) {
    return {
      operation: 'Join',
      target: restsOn,
      reason: `Join, because it stands on ${describe(restsOn)}.`,
    };
  }
  return { operation: 'New body', target: null, reason: null };
}
