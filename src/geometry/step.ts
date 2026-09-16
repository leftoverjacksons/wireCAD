import type { OpenCascadeInstance, Shape } from './kernel.js';

/**
 * Measured against this build: the STEP writer honours paths of at most ten
 * characters. Longer ones still report success while nothing reaches the
 * filesystem, so this name is deliberately short and must stay that way.
 */
const STEP_PATH = '/e.step';

/** STEP AP214 bytes for a shape. OpenCASCADE writes millimetres by default. */
export function writeStep(oc: OpenCascadeInstance, shape: Shape): Uint8Array<ArrayBuffer> {
  const path = STEP_PATH;

  // The writer must be released before the file is readable: with writers left
  // alive, Write keeps reporting success while nothing lands in the filesystem.
  const writer = new oc.STEPControl_Writer_1();
  try {
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
    writer.Write(path);
  } finally {
    writer.delete?.();
  }

  try {
    const bytes = oc.FS.readFile(path) as Uint8Array;
    if (bytes.length === 0) throw new Error('The kernel produced an empty STEP file');

    // Copy out: the view may sit on the WASM heap, which must not be transferred.
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    copy.set(bytes);
    return copy;
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // The file may never have been created; nothing to clean up.
    }
  }
}
