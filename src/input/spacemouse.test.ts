import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  ZERO_AXES,
  isStill,
  parseSettings,
  pressed,
  readReport,
  STILL,
  separate,
  shapeAxis,
  smoothMotion,
  toMotion,
} from './spacemouse.js';

function report(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return view;
}

function bytes(...values: number[]): DataView {
  return new DataView(new Uint8Array(values).buffer);
}

describe('readReport', () => {
  it('reads all six axes from a twelve-byte report 1, as newer devices send', () => {
    const { axes, changed } = readReport(ZERO_AXES, 0, 1, report(10, -20, 30, -40, 50, -60));
    expect(changed).toBe('axes');
    expect(axes).toEqual({ tx: 10, ty: -20, tz: 30, rx: -40, ry: 50, rz: -60 });
  });

  it('keeps the rotation from report 2 when an older device sends translation alone', () => {
    const afterRotation = readReport(ZERO_AXES, 0, 2, report(7, 8, 9)).axes;
    const { axes } = readReport(afterRotation, 0, 1, report(1, 2, 3));
    expect(axes).toEqual({ tx: 1, ty: 2, tz: 3, rx: 7, ry: 8, rz: 9 });
  });

  it('reads the buttons as a bitmask across bytes, leaving the axes alone', () => {
    const held = { ...ZERO_AXES, tx: 100 };
    const result = readReport(held, 0, 3, bytes(0b10, 0b1));
    expect(result.changed).toBe('buttons');
    expect(result.buttons).toBe(0b1_0000_0010);
    expect(result.axes).toBe(held);
  });

  it('ignores reports it does not understand rather than misreading them', () => {
    const result = readReport(ZERO_AXES, 5, 0x17, bytes(1, 2, 3));
    expect(result.changed).toBeNull();
    expect(result.buttons).toBe(5);
  });

  it('reads negative values as negative, not as large positives', () => {
    expect(readReport(ZERO_AXES, 0, 2, report(-350, 0, 0)).axes.rx).toBe(-350);
  });
});

describe('shapeAxis', () => {
  it('treats the drift of a cap at rest as no motion', () => {
    expect(shapeAxis(5)).toBe(0);
    expect(shapeAxis(-12)).toBe(0);
  });

  it('starts from zero at the edge of the dead zone instead of jumping', () => {
    expect(shapeAxis(16)).toBeGreaterThan(0);
    expect(shapeAxis(16)).toBeLessThan(0.001);
  });

  it('reaches full speed at full deflection and no further', () => {
    expect(shapeAxis(350)).toBeCloseTo(1);
    expect(shapeAxis(-900)).toBeCloseTo(-1);
  });

  it('is gentler than linear part way, so a light touch can place the view', () => {
    expect(shapeAxis(175)).toBeLessThan(0.5);
    expect(shapeAxis(175)).toBeGreaterThan(0.2);
  });
});

describe('toMotion', () => {
  it('turns pressing the cap down into moving down, and pulling it towards you into backwards', () => {
    const motion = toMotion({ ...ZERO_AXES, tz: 350, ty: 350 }, DEFAULT_SETTINGS);
    expect(motion.pan.z).toBeCloseTo(-1);
    expect(motion.pan.y).toBeCloseTo(-1);
  });

  it('turns a clockwise twist, seen from above, into a negative turn about up', () => {
    // Raw z points down, so a twist right-handed about it is clockwise from above.
    expect(toMotion({ ...ZERO_AXES, rz: 350 }, DEFAULT_SETTINGS).rotate.z).toBeCloseTo(-1);
  });

  it('inverts only what the setting names', () => {
    const axes = { tx: 350, ty: 350, tz: 350, rx: 350, ry: 350, rz: 350 };
    const plain = toMotion(axes, DEFAULT_SETTINGS);
    const flipped = toMotion(axes, { ...DEFAULT_SETTINGS, invertZoom: true });
    expect(flipped.pan.y).toBeCloseTo(-plain.pan.y);
    expect(flipped.pan.x).toBeCloseTo(plain.pan.x);
    expect(flipped.rotate).toEqual(plain.rotate);
  });

  it('is still when the cap is at rest', () => {
    expect(isStill(toMotion({ ...ZERO_AXES, tx: 3, rz: -4 }, DEFAULT_SETTINGS))).toBe(true);
  });
});

describe('pressed', () => {
  it('names only the buttons that have just gone down', () => {
    expect(pressed(0b01, 0b11)).toEqual([1]);
    expect(pressed(0b11, 0b01)).toEqual([]);
  });
});

describe('parseSettings', () => {
  it('falls back to the defaults for nothing stored or something unreadable', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps what is valid and defaults the rest', () => {
    expect(parseSettings('{"speed": 2, "invertPan": true, "invertZoom": "yes"}')).toEqual({
      ...DEFAULT_SETTINGS,
      speed: 2,
      invertPan: true,
    });
  });

  it('keeps the speed within a range that still moves the view usefully', () => {
    expect(parseSettings('{"speed": 0}').speed).toBe(0.1);
    expect(parseSettings('{"speed": 1e9}').speed).toBe(10);
  });
});

describe('speed', () => {
  it('scales every axis alike', () => {
    const axes = { tx: 350, ty: 0, tz: 0, rx: 0, ry: 0, rz: 350 };
    const fast = toMotion(axes, { ...DEFAULT_SETTINGS, speed: 2 });
    expect(fast.pan.x).toBeCloseTo(2);
    expect(fast.rotate.z).toBeCloseTo(-2);
  });
});

describe('separate', () => {
  it('leaves the stronger axis alone and all but removes an incidental weaker one', () => {
    const [push, tip] = separate(0.8, 0.1);
    expect(push).toBe(0.8);
    expect(tip).toBeCloseTo(0.1 / 64);
  });

  it('passes both when both are meant, equally', () => {
    expect(separate(-0.5, 0.5)).toEqual([-0.5, 0.5]);
  });

  it('keeps each sign', () => {
    const [a, b] = separate(-0.9, -0.3);
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(0);
  });

  it('stops a push forward from tipping the view', () => {
    // A firm push with the tip a cap gives it on the way.
    const motion = toMotion({ ...ZERO_AXES, ty: -300, rx: 90 }, DEFAULT_SETTINGS);
    expect(motion.pan.y).toBeGreaterThan(0.7);
    expect(Math.abs(motion.rotate.x)).toBeLessThan(0.002);
  });
});

describe('smoothMotion', () => {
  const full = { pan: { x: 1, y: 0, z: 0 }, rotate: { x: 0, y: 0, z: 0 } };

  it('moves part of the way in one frame rather than jumping', () => {
    const eased = smoothMotion(STILL, full, 1 / 60);
    expect(eased.pan.x).toBeGreaterThan(0.2);
    expect(eased.pan.x).toBeLessThan(0.4);
  });

  it('gets to the same place at any frame rate', () => {
    let fast = STILL;
    for (let i = 0; i < 12; i++) fast = smoothMotion(fast, full, 1 / 120);
    let slow = STILL;
    for (let i = 0; i < 6; i++) slow = smoothMotion(slow, full, 1 / 60);
    expect(fast.pan.x).toBeCloseTo(slow.pan.x, 10);
  });

  it('comes to rest exactly once the cap is let go', () => {
    let eased = full;
    for (let i = 0; i < 30; i++) eased = smoothMotion(eased, STILL, 1 / 60);
    expect(isStill(eased)).toBe(true);
  });
});
