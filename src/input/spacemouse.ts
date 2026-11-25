/**
 * What a 3Dconnexion SpaceMouse says, turned into how the view should move.
 *
 * Nothing here touches the browser: the HID glue feeds raw reports in, and the
 * viewport takes shaped motion out. Kept apart so the arithmetic can be tested
 * without a device, which is the only way it will be tested on most machines.
 */

/** Raw axis values as the device reports them, about ±350 at full deflection. */
export interface RawAxes {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Motion in the frame of the cap as a person sees it from their chair: x to
 * the right, y away from them, z up. Rotations are right-handed about those
 * same axes. Each component is in [-1, 1] after the dead zone and the curve,
 * then multiplied by the speed setting.
 */
export interface Motion {
  pan: Vec3;
  rotate: Vec3;
}

export interface SpaceMouseSettings {
  /** Multiplies every speed. 1 is the default feel. */
  speed: number;
  invertPan: boolean;
  invertZoom: boolean;
  invertRotate: boolean;
}

export const DEFAULT_SETTINGS: Readonly<SpaceMouseSettings> = {
  speed: 1,
  invertPan: false,
  invertZoom: false,
  invertRotate: false,
};

export const ZERO_AXES: Readonly<RawAxes> = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

export const STILL: Readonly<Motion> = {
  pan: { x: 0, y: 0, z: 0 },
  rotate: { x: 0, y: 0, z: 0 },
};

/**
 * Full deflection. Devices differ a little — some reach 350, some a few counts
 * more — so values past this are clamped rather than trusted to scale.
 */
const FULL_SCALE = 350;

/**
 * The cap never rests at exactly zero: it settles a few counts off and drifts.
 * Without a dead zone the view creeps while nobody is touching anything.
 */
const DEAD_ZONE = 0.04;

/**
 * 3Dconnexion vendor IDs. Current devices are 0x256F; the older ones, sold
 * when 3Dconnexion was part of Logitech, carry Logitech's 0x046D, which is why
 * that one is narrowed to the multi-axis usage below rather than taken whole.
 */
export const VENDOR_3DCONNEXION = 0x256f;
export const VENDOR_LOGITECH = 0x046d;
/** HID Generic Desktop page, Multi-axis Controller usage. */
export const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
export const USAGE_MULTI_AXIS = 0x08;

/**
 * Folds one input report into the axes and buttons held so far.
 *
 * Two layouts are in circulation. Older devices send translation and rotation
 * as separate reports (1 and 2), three little-endian int16s each. Newer ones
 * send all six in report 1, twelve bytes. Report 3 is the button bitmask on
 * both. The report ID is not part of `data`; WebHID hands it over separately.
 *
 * Returns what changed, so the caller can tell motion from a button press.
 */
export function readReport(
  axes: RawAxes,
  buttons: number,
  reportId: number,
  data: DataView,
): { axes: RawAxes; buttons: number; changed: 'axes' | 'buttons' | null } {
  const int16 = (offset: number): number => data.getInt16(offset, true);

  if (reportId === 1 && data.byteLength >= 12) {
    return {
      axes: { tx: int16(0), ty: int16(2), tz: int16(4), rx: int16(6), ry: int16(8), rz: int16(10) },
      buttons,
      changed: 'axes',
    };
  }
  if (reportId === 1 && data.byteLength >= 6) {
    return { axes: { ...axes, tx: int16(0), ty: int16(2), tz: int16(4) }, buttons, changed: 'axes' };
  }
  if (reportId === 2 && data.byteLength >= 6) {
    return { axes: { ...axes, rx: int16(0), ry: int16(2), rz: int16(4) }, buttons, changed: 'axes' };
  }
  if (reportId === 3 && data.byteLength >= 1) {
    let mask = 0;
    // Only the first four bytes: a 32-bit mask covers every device with fewer
    // than 33 buttons, and JavaScript's bitwise operators stop there anyway.
    for (let i = 0; i < Math.min(data.byteLength, 4); i++) mask |= data.getUint8(i) << (8 * i);
    return { axes, buttons: mask >>> 0, changed: 'buttons' };
  }
  // Battery level, LED state and the like: nothing that moves the view.
  return { axes, buttons, changed: null };
}

/** One axis: clamped, dead zone removed, then curved for fine control near rest. */
export function shapeAxis(raw: number): number {
  const v = Math.max(-1, Math.min(1, raw / FULL_SCALE));
  const magnitude = Math.abs(v);
  if (magnitude <= DEAD_ZONE) return 0;
  // Rescaled so the output starts from zero at the edge of the dead zone
  // rather than jumping to it.
  const past = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
  // Squared: a light touch moves the view slowly enough to place it, and full
  // deflection still reaches full speed.
  return Math.sign(v) * past * past;
}

/**
 * Raw device axes to motion in the cap's own frame, with the person's
 * inversions applied.
 *
 * The raw frame is x right, y towards the person, z down — the cap is pushed
 * down to make z positive — with rotations right-handed about those axes. That
 * frame is taken from public descriptions of the protocol, not measured here;
 * the inversion settings are the remedy if a device disagrees.
 */
export function toMotion(axes: RawAxes, settings: SpaceMouseSettings): Motion {
  const pan = (settings.invertPan ? -1 : 1) * settings.speed;
  const zoom = (settings.invertZoom ? -1 : 1) * settings.speed;
  const turn = (settings.invertRotate ? -1 : 1) * settings.speed;
  const [push, tip] = separate(shapeAxis(axes.ty), shapeAxis(axes.rx));
  const [slide, roll] = separate(shapeAxis(axes.tx), shapeAxis(axes.ry));
  return {
    pan: {
      x: pan * slide,
      y: zoom * -push,
      z: pan * -shapeAxis(axes.tz),
    },
    rotate: {
      x: turn * tip,
      y: turn * -roll,
      z: turn * -shapeAxis(axes.rz),
    },
  };
}

/**
 * Pulls apart two axes the cap's mechanics tie together.
 *
 * The cap pivots as well as slides, so pushing it forward tips it a little and
 * tipping it pushes it a little. Taken at face value, every zoom wobbles the
 * view as that incidental tip crosses in and out of the dead zone. The weaker
 * of the pair is scaled by the square of how weak it is relative to the other:
 * the stronger is untouched, an incidental third of it is cut to a ninth, and
 * both at once, deliberately and equally, still pass.
 */
export function separate(a: number, b: number): [number, number] {
  const strongest = Math.max(Math.abs(a), Math.abs(b));
  if (strongest === 0) return [a, b];
  const weight = (v: number): number => (Math.abs(v) / strongest) ** 2;
  return [a * weight(a), b * weight(b)];
}

/**
 * Below this, a smoothed component is taken to have arrived at rest. Without
 * it the exponential approach never quite reaches zero and the view keeps
 * creeping long after the cap is let go.
 */
const SETTLED = 0.002;

/**
 * Eases motion towards what the cap now says, over about `tau` seconds.
 *
 * Reports arrive on the device's schedule, not the screen's, and each carries
 * a few counts of noise; used raw, the speed of the view jumps with every one.
 * Exponential smoothing by elapsed time behaves the same at any frame rate.
 */
export function smoothMotion(previous: Motion, next: Motion, seconds: number, tau = 0.05): Motion {
  const keep = Math.exp(-Math.max(seconds, 0) / tau);
  const ease = (from: number, to: number): number => {
    const value = to + (from - to) * keep;
    return to === 0 && Math.abs(value) < SETTLED ? 0 : value;
  };
  const vec = (from: Vec3, to: Vec3): Vec3 => ({
    x: ease(from.x, to.x),
    y: ease(from.y, to.y),
    z: ease(from.z, to.z),
  });
  return { pan: vec(previous.pan, next.pan), rotate: vec(previous.rotate, next.rotate) };
}

export function isStill(motion: Motion): boolean {
  const { pan, rotate } = motion;
  return (
    pan.x === 0 && pan.y === 0 && pan.z === 0 && rotate.x === 0 && rotate.y === 0 && rotate.z === 0
  );
}

/** Buttons that went down in this report and were up in the last. */
export function pressed(before: number, after: number): number[] {
  const down: number[] = [];
  const fresh = after & ~before;
  for (let bit = 0; bit < 32; bit++) if ((fresh >>> bit) & 1) down.push(bit);
  return down;
}

/** Settings read back from storage, with anything missing or malformed defaulted. */
export function parseSettings(text: string | null): SpaceMouseSettings {
  if (text === null) return { ...DEFAULT_SETTINGS };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS };
    const record = value as Record<string, unknown>;
    const flag = (key: keyof SpaceMouseSettings): boolean =>
      typeof record[key] === 'boolean' ? (record[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean);
    const speed =
      typeof record.speed === 'number' && Number.isFinite(record.speed)
        ? Math.min(Math.max(record.speed, 0.1), 10)
        : DEFAULT_SETTINGS.speed;
    return {
      speed,
      invertPan: flag('invertPan'),
      invertZoom: flag('invertZoom'),
      invertRotate: flag('invertRotate'),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
