export const AUTOSAVE_KEY = 'wirecad.autosave.v1';
/** Where a session that would not reopen is kept, rather than written over. */
export const REJECTED_KEY = 'wirecad.autosave.v1.rejected';

export function download(data: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    // A cancelled picker fires nothing in most browsers; the promise simply
    // never settles, which is harmless here because nothing awaits it forever.
    input.click();
  });
}

/** Storage is unavailable in private windows and can be over quota; never fatal. */
export function writeAutosave(text: string): boolean {
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function readAutosave(): string | null {
  try {
    return window.localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    window.localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export function timestampedName(extension: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `wirecad-${stamp}.${extension}`;
}

/**
 * Puts aside a session that could not be reopened.
 *
 * The next autosave is moments away and would write over it, and a document
 * that failed to load is exactly the one worth keeping: it is somebody's work,
 * and it is the evidence for why it would not open.
 */
export function keepRejected(text: string): void {
  try {
    window.localStorage.setItem(REJECTED_KEY, text);
  } catch {
    // Out of room, or storage refused: losing the copy is not worth a failure.
  }
}

export function readRejected(): string | null {
  try {
    return window.localStorage.getItem(REJECTED_KEY);
  } catch {
    return null;
  }
}
