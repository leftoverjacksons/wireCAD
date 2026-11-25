/**
 * Records what reaches the page from an input device, for a few seconds, so a
 * fault that only shows up on someone else's hardware can be read rather than
 * guessed at.
 *
 * Only ever started by hand, from the SpaceMouse menu, and only for as long as
 * it says; the keys it notes are there because a driver may send keystrokes of
 * its own, and the file goes nowhere but the person's own downloads.
 */
export interface Entry {
  /** Milliseconds since recording began. */
  t: number;
  kind: string;
  [field: string]: unknown;
}

export class InputRecorder {
  private entries: Entry[] | null = null;
  private began = 0;

  get recording(): boolean {
    return this.entries !== null;
  }

  record(kind: string, fields: Record<string, unknown> = {}): void {
    if (this.entries === null) return;
    const t = Math.round((performance.now() - this.began) * 10) / 10;
    this.entries.push({ t, kind, ...fields });
  }

  /** Records for `milliseconds`, then hands over everything seen. */
  run(milliseconds: number, done: (entries: Entry[]) => void): void {
    if (this.entries !== null) return;
    this.entries = [];
    this.began = performance.now();
    window.setTimeout(() => {
      const entries = this.entries ?? [];
      this.entries = null;
      done(entries);
    }, milliseconds);
  }
}
