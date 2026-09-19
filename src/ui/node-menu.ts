import type { Graph } from '../core/graph.js';
import { branchOf, passThroughOf } from '../core/rewire.js';
import type { DataType, NodeId } from '../core/types.js';
import { typeLabel } from './kind.js';
import type { MenuItem } from './menu.js';

/**
 * What a node's context menu offers, worked out from the graph alone.
 *
 * This is a description rather than a menu: the editor draws it and calls back,
 * and the awkward part — what deleting this particular node will do to the rest
 * of the document — is decided here, where it can be tested without a browser.
 *
 * Nothing is left out because it cannot be done. An entry that would not work
 * says why instead, because "the menu does not have that today" and "that would
 * not mean anything for this node" look identical when the entry is missing.
 */

export type NodeMenuAction =
  | 'edit'
  | 'roll-back'
  | 'return'
  | 'rename'
  | 'hide'
  | 'show'
  | 'auto'
  | 'suppress'
  | 'unsuppress'
  | 'delete'
  | 'delete-branch';

/** A menu entry whose action is one this module knows about. */
export interface NodeMenuItem extends MenuItem {
  action: NodeMenuAction;
}

export interface NodeMenuState {
  /** Whether this build can reopen the node for editing. */
  editable: boolean;
  /** Whether the node's result is on screen, as the last solve left it. */
  shown: boolean;
  /** The point in the history the view is rolled back to, if it is. */
  rolledBackTo?: NodeId | null;
}

function nameOf(graph: Graph, nodeId: NodeId): string {
  return graph.getNode(nodeId)?.label ?? graph.schemaOf(nodeId).label;
}

function nodes(count: number): string {
  return count === 1 ? '1 node' : `${count} nodes`;
}

export interface DeleteOutcome {
  /** Wires that would be rewired to what this node was reading. */
  healed: number;
  /** Wires that would be lost, because nothing can stand in their place. */
  stranded: number;
  /** What takes its place, where anything does. */
  into: string | null;
}

/**
 * What removing this node would do to everything wired to it.
 *
 * The count is exact rather than a guess: a wire off the pass-through output
 * always reconnects, since the input it lands on is freed by the removal
 * itself, and the type it wants is the type coming down the wire either way.
 */
export function deleteOutcome(graph: Graph, nodeId: NodeId): DeleteOutcome {
  const wires = graph.outgoingEdges(nodeId);
  const through = passThroughOf(graph, nodeId);
  const upstream = through === null ? undefined : graph.incomingEdge(nodeId, through.input);

  if (through === null || upstream === undefined) {
    return { healed: 0, stranded: wires.length, into: null };
  }

  const healed = wires.filter((edge) => edge.from.port === through.output).length;
  return { healed, stranded: wires.length - healed, into: nameOf(graph, upstream.from.node) };
}

function describeDelete(outcome: DeleteOutcome): string | undefined {
  const { healed, stranded, into } = outcome;
  if (healed === 0 && stranded === 0) return undefined;
  if (stranded === 0) {
    return `${nodes(healed)} ${healed === 1 ? 'reads' : 'read'} ${into} instead`;
  }
  if (healed === 0) return `${nodes(stranded)} left without an input`;
  return `${healed} rewired to ${into}, ${stranded} left without an input`;
}

/** The kind of thing a node hands on, in the words the badges use. */
function passing(type: DataType): string {
  return typeLabel(type) ?? type;
}

export function nodeMenu(graph: Graph, nodeId: NodeId, state: NodeMenuState): NodeMenuItem[] {
  const node = graph.requireNode(nodeId);
  const schema = graph.schemaOf(nodeId);
  const items: NodeMenuItem[] = [];

  items.push(
    state.editable
      ? { action: 'edit', label: 'Edit' }
      : { action: 'edit', label: 'Edit', refusal: 'Nothing here reopens for editing' },
  );

  const drawable = schema.outputs.some(
    (port) => port.type === 'geometry' || port.type === 'sketch',
  );

  // Looking at the model as it was when this feature was made. Not an edit: the
  // whole history is present after a solve, so this only changes what is drawn.
  const marker = state.rolledBackTo ?? null;
  if (marker === nodeId) {
    items.push({ action: 'return', label: 'Return to now', detail: 'stop looking back' });
  } else if (!drawable) {
    items.push({
      action: 'roll-back',
      label: 'Roll back to here',
      refusal: 'This node makes nothing to look at',
    });
  } else {
    items.push({
      action: 'roll-back',
      label: 'Roll back to here',
      detail: 'the model as it was',
    });
  }
  if (marker !== null && marker !== nodeId) {
    items.push({ action: 'return', label: 'Return to now', detail: `from ${nameOf(graph, marker)}` });
  }

  items.push({ action: 'rename', label: 'Rename' });
  // What the document says, where it says anything; otherwise what is on
  // screen. The two part company all the time — a hidden node is drawn as a
  // ghost while it is selected — and the entry is about the setting, so
  // offering "Hide" for something already set to be hidden would do nothing.
  const drawn = node.visible ?? state.shown;
  if (!drawable) {
    items.push({ action: 'hide', label: 'Hide', refusal: 'This node makes nothing to draw' });
  } else if (drawn) {
    items.push({ action: 'hide', label: 'Hide' });
  } else {
    items.push({ action: 'show', label: 'Show' });
  }

  // Only worth offering once the answer has been pinned, since that is the only
  // state the automatic rule is not already in.
  if (drawable && node.visible !== undefined) {
    items.push({ action: 'auto', label: 'Draw automatically', detail: 'as the model decides' });
  }

  const through = passThroughOf(graph, nodeId);
  if (node.suppressed === true) {
    items.push({ action: 'unsuppress', label: 'Unsuppress', detail: 'let the feature act again' });
  } else if (through === null) {
    items.push({
      action: 'suppress',
      label: 'Suppress',
      refusal: 'Nothing passes through this node',
    });
  } else {
    items.push({
      action: 'suppress',
      label: 'Suppress',
      detail: `hands its ${passing(through.type)} on untouched`,
    });
  }

  const damage = describeDelete(deleteOutcome(graph, nodeId));
  items.push({
    action: 'delete',
    label: 'Delete',
    divide: true,
    ...(damage === undefined ? {} : { detail: damage }),
  });

  // Taking the branch is only a different thing to do when there is a branch.
  const branch = branchOf(graph, nodeId).size;
  if (branch > 1) {
    items.push({
      action: 'delete-branch',
      label: 'Delete branch',
      detail: `${nodes(branch - 1)} after it ${branch === 2 ? 'goes' : 'go'} too`,
    });
  }

  return items;
}
