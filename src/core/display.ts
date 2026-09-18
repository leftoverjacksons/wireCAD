import type { Graph } from './graph.js';
import type { NodeId, PortId } from './types.js';

/**
 * What the viewport draws, and why.
 *
 * The rule the model runs on is one sentence: a node is drawn unless something
 * downstream consumes its geometry to make geometry. Everything else here is
 * that sentence with two exceptions — a node somebody asked to see, and a view
 * rolled back to an earlier point in the history.
 *
 * Rolling back is not a recomputation. Every node's output is a value that
 * already exists after a solve, so the block before the bore did not stop
 * existing when the bore was cut: the whole history is present at once, and
 * "roll back to N" is the single addition that everything downstream of N is
 * treated as absent. That is what puts N's own result back on screen.
 */

export type DisplayMode =
  /** Drawn as the model itself. */
  | 'model'
  /** Drawn as an outline: what is built on the point being looked at. */
  | 'outline'
  /** On screen only because something asked for it. */
  | 'asked';

export interface Shown {
  /** The output whose geometry is drawn. */
  portId: PortId;
  kind: 'solid' | 'sketch';
  mode: DisplayMode;
}

export interface DisplayOptions {
  /** Nodes to keep on screen although something downstream has replaced them. */
  pinned?: ReadonlySet<NodeId>;
  /** The point in the history the view is rolled back to, if it is. */
  rolledBackTo?: NodeId | null;
}

/** The output whose geometry a node is drawn by, if it has one. */
function displayableOf(graph: Graph, nodeId: NodeId) {
  // A profile that has already been extruded is scaffolding rather than a body,
  // so one rule covers sketches and solids alike.
  return graph
    .schemaOf(nodeId)
    .outputs.find((port) => port.type === 'sketch' || port.type === 'geometry');
}

/**
 * Everything a view rolled back to `marker` treats as not having happened.
 *
 * Downstream of the marker, to begin with. But also whatever was only ever
 * drawn *for* something downstream: the circle a bore is cut with is not part
 * of the model before the bore — it exists for the bore, and with the bore
 * absent it would otherwise reappear as a ring floating in space, because
 * nothing is left consuming it.
 *
 * Repeated passes, because a node is only left unused once everything reading
 * it is, and that can become true late.
 */
function absentAt(graph: Graph, marker: NodeId): Set<NodeId> {
  const absent = graph.downstreamOf(marker);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.allNodes()) {
      if (node.id === marker || absent.has(node.id)) continue;

      const displayable = displayableOf(graph, node.id);
      if (displayable === undefined) continue;

      const consumers = graph
        .outgoingEdges(node.id)
        .filter((edge) => edge.from.port === displayable.id);
      // Nothing was reading it in the first place, so it stands on its own.
      if (consumers.length === 0) continue;
      if (!consumers.every((edge) => absent.has(edge.to.node))) continue;

      absent.add(node.id);
      changed = true;
    }
  }

  return absent;
}

export function planDisplay(graph: Graph, options: DisplayOptions = {}): Map<NodeId, Shown> {
  const pinned = options.pinned ?? new Set<NodeId>();
  const marker = options.rolledBackTo ?? null;

  // A marker on a node that has since gone is no marker at all.
  const valid = marker !== null && graph.getNode(marker) !== undefined;
  const absent = valid ? absentAt(graph, marker!) : new Set<NodeId>();

  const plan = new Map<NodeId, Shown>();

  for (const node of graph.allNodes()) {
    const displayable = displayableOf(graph, node.id);
    if (displayable === undefined) continue;

    // A solid is replaced only by something that makes geometry out of it. A
    // query node such as face.plane reads the solid without standing in for it,
    // so the body it reads must stay on screen.
    const replacing = graph
      .outgoingEdges(node.id)
      .filter((edge) => edge.from.port === displayable.id)
      .filter((edge) =>
        graph.schemaOf(edge.to.node).outputs.some((port) => port.type === 'geometry'),
      );

    // An explicit flag on the node overrides the guess in either direction.
    const wanted = (replaced: boolean): boolean =>
      node.visible !== false && (node.visible === true || !replaced);

    const beyond = absent.has(node.id);
    const model = !beyond && wanted(replacing.some((edge) => !absent.has(edge.to.node)));
    // Only what would be the model if nothing were rolled back gets an outline.
    // Outlining every node in the cone would draw the same body several times
    // over, each one a feature's worth different from the last.
    const outline = beyond && wanted(replacing.length > 0);

    const mode: DisplayMode | null = model
      ? 'model'
      : outline
        ? 'outline'
        : pinned.has(node.id)
          ? 'asked'
          : null;
    if (mode === null) continue;

    plan.set(node.id, {
      portId: displayable.id,
      kind: displayable.type === 'sketch' ? 'sketch' : 'solid',
      mode,
    });
  }

  return plan;
}
