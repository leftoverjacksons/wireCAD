import type { PortId, Value } from './types.js';

export interface CacheEntry {
  readonly outputs: Record<PortId, Value> | null;
  readonly error: string | null;
}

export type DisposeEntry = (entry: CacheEntry) => void;

interface Slot {
  entry: CacheEntry;
  generation: number;
}

/**
 * Entries touched during the current generation are never evicted, so kernel
 * shapes cannot be freed while the in-flight solve still references them.
 */
export class LruCache {
  private entries = new Map<string, Slot>();
  private generation = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries = 4096,
    private readonly dispose?: DisposeEntry,
  ) {}

  beginGeneration(): void {
    this.generation++;
  }

  get(key: string): CacheEntry | undefined {
    const slot = this.entries.get(key);
    if (slot === undefined) {
      this.misses++;
      return undefined;
    }
    slot.generation = this.generation;
    this.entries.delete(key);
    this.entries.set(key, slot);
    this.hits++;
    return slot.entry;
  }

  set(key: string, entry: CacheEntry): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.dispose?.(existing.entry);
    }
    this.entries.set(key, { entry, generation: this.generation });
    this.evict();
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, slot] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (slot.generation === this.generation) continue;
      this.entries.delete(key);
      this.dispose?.(slot.entry);
    }
  }

  clear(): void {
    for (const slot of this.entries.values()) this.dispose?.(slot.entry);
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }
}
