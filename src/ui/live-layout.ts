import type { Graph } from '../core/graph.js';
import type { NodeId } from '../core/types.js';
import { planLayout } from './layout.js';

type Position = { x: number; y: number };

/**
 * How much of the way to its target a node covers each frame. At sixty
 * frames a second that settles in about a third of a second: quick enough to
 * keep up with the work, slow enough to see where things went.
 */
const GLIDE = 0.2;
/** Closer than this, in graph pixels, a node is where it is going. */
const ARRIVED = 0.5;

/**
 * Keeps the graph laid out, and moves it there gently.
 *
 * Whenever the wiring changes, the layout is worked out again and every node
 * glides to its new place, then the graph rests: alive when something changes,
 * still while you work. A document that is opened — or put back by undo —
 * simply appears laid out, because there is nothing to watch move.
 *
 * A node being dragged is held where the pointer has it, and the rest make
 * room for it as it goes; dropped, it is pinned there.
 */
export class LiveLayout {
  private targets = new Map<NodeId, Position>();
  /** Nodes the layout has placed at least once; any other is new. */
  private known = new Set<NodeId>();
  private held = new Map<NodeId, Position>();
  private frame: number | null = null;
  private planned = false;
  /** Set while this class moves nodes, so its own moves are not changes to react to. */
  private moving = false;

  constructor(private readonly graph: Graph) {
    graph.subscribe((change) => {
      if (this.moving) return;
      switch (change.kind) {
        case 'node-moved':
        case 'node-renamed':
        case 'node-visibility':
        case 'node-suppressed':
          return;
        case 'document-replaced':
          // A document's nodes arrive already somewhere: none of them is new.
          this.known = new Set(graph.allNodes().map((node) => node.id));
          this.replan(true);
          return;
        default:
          // A feature is built from several changes in a row — a node, then its
          // wires. Planning once, after the last of them, lays out the feature
          // rather than each half-built step of it.
          this.schedule();
      }
    });
  }

  /** Where a node is going, or where it is if it is not going anywhere. */
  targetOf(nodeId: NodeId): Position | null {
    return this.targets.get(nodeId) ?? this.graph.getNode(nodeId)?.position ?? null;
  }

  /** A node the pointer is dragging: hold it there, and lay the rest out around it. */
  hold(nodeId: NodeId, at: Position): void {
    this.held.set(nodeId, at);
    this.replan(false);
  }

  /** The drag is over. */
  release(nodeId: NodeId): void {
    this.held.delete(nodeId);
    this.replan(false);
  }

  /** Lays the graph out now, without the glide: for a document that has just appeared. */
  settle(): void {
    this.known = new Set(this.graph.allNodes().map((node) => node.id));
    this.replan(true);
  }

  private schedule(): void {
    if (this.planned) return;
    this.planned = true;
    queueMicrotask(() => {
      this.planned = false;
      this.replan(false);
    });
  }

  private replan(instant: boolean): void {
    const fresh = new Set(
      this.graph
        .allNodes()
        .map((node) => node.id)
        .filter((id) => !this.known.has(id)),
    );
    this.targets = planLayout(this.graph, { hold: this.held, fresh });
    this.known = new Set(this.targets.keys());
    if (instant) {
      this.moving = true;
      try {
        for (const [nodeId, at] of this.targets) {
          if (!this.held.has(nodeId)) this.graph.setPosition(nodeId, at);
        }
      } finally {
        this.moving = false;
      }
      return;
    }
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.step());
  }

  private step(): void {
    this.frame = null;
    let travelling = false;

    this.moving = true;
    try {
      for (const [nodeId, target] of this.targets) {
        if (this.held.has(nodeId)) continue;
        const node = this.graph.getNode(nodeId);
        if (node === undefined) continue;

        const dx = target.x - node.position.x;
        const dy = target.y - node.position.y;
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) < ARRIVED && Math.abs(dy) < ARRIVED) {
          this.graph.setPosition(nodeId, target);
          continue;
        }
        travelling = true;
        this.graph.setPosition(nodeId, {
          x: node.position.x + dx * GLIDE,
          y: node.position.y + dy * GLIDE,
        });
      }
    } finally {
      this.moving = false;
    }

    if (travelling) this.frame = requestAnimationFrame(() => this.step());
  }
}
