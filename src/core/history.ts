import type { Graph, SerializedGraph } from './graph.js';

/**
 * Snapshot history over the serialized document.
 *
 * `capture` must be called immediately before a mutation, and callers that
 * mutate continuously (dragging a node or a slider) capture once on the first
 * change of the gesture, so one drag is one undo step.
 */
export class History {
  private readonly past: SerializedGraph[] = [];
  private readonly future: SerializedGraph[] = [];

  constructor(
    private readonly graph: Graph,
    private readonly limit = 100,
  ) {}

  capture(): void {
    this.past.push(this.graph.toJSON());
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(): boolean {
    const previous = this.past.pop();
    if (previous === undefined) return false;
    this.future.push(this.graph.toJSON());
    this.graph.restore(previous);
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.graph.toJSON());
    this.graph.restore(next);
    return true;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}
