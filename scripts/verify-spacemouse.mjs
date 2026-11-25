/**
 * Checks that a SpaceMouse moves the view the way its cap is pushed.
 *
 * No device is plugged in where this runs, so the reports a device would send
 * are fed to the same handler WebHID would call, with a stand-in for the device
 * itself. Everything after that — the parsing, the shaping, the per-frame
 * camera motion, the buttons — is the real code.
 *
 *   npm run dev
 *   npm run verify:spacemouse
 */
import { chromium } from 'playwright';

const url = process.env.WIRECAD_URL ?? 'http://localhost:5173/';
const executablePath = process.env.CHROMIUM_PATH;
const shots = process.env.SHOTS_DIR;

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
  .locator('#kernel-status')
  .filter({ hasText: 'kernel ready' })
  .waitFor({ timeout: 180_000 });

await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { viewport, spaceMouse } = window.wirecad;

  // Starts from the starter model, framed, with default settings.
  window.localStorage.removeItem('wirecad.spacemouse');
  spaceMouse.updateSettings({ speed: 1, invertPan: false, invertZoom: false, invertRotate: false });

  // A stand-in for an opened device: enough for the class to count itself
  // connected. Reports go to the handler WebHID would call.
  spaceMouse.device = {
    productName: 'Test SpaceMouse',
    removeEventListener() {},
    close: async () => undefined,
  };
  // Told as a real connection would tell it, so the button lights.
  spaceMouse.changed();

  window.__send = (reportId, values, bytes = false) => {
    const view = bytes
      ? new DataView(new Uint8Array(values).buffer)
      : (() => {
          const v = new DataView(new ArrayBuffer(values.length * 2));
          values.forEach((value, i) => v.setInt16(i * 2, value, true));
          return v;
        })();
    spaceMouse.onReport({ reportId, data: view });
  };
  /** Holds the cap in one position for a while, then lets go. */
  window.__hold = async (axes, ms = 400) => {
    window.__send(1, axes);
    await sleep(ms);
    window.__send(1, [0, 0, 0, 0, 0, 0]);
    // Long enough for the smoothing to bring the view to rest.
    await sleep(500);
  };
  window.__press = async (mask) => {
    window.__send(3, [mask, 0], true);
    await sleep(50);
    window.__send(3, [0, 0], true);
    await sleep(120);
  };
  window.__pose = () => {
    const camera = viewport.camera;
    const target = viewport.controls.target;
    const offset = camera.position.clone().sub(target);
    return {
      target: target.toArray(),
      offset: offset.toArray(),
      direction: offset.clone().normalize().toArray(),
      zoom: camera.zoom,
      azimuth: Math.atan2(offset.y, offset.x),
      polar: offset.angleTo(camera.up),
    };
  };
  window.__centre = () => {
    const mesh = window.wirecad.meshes().find((m) => m.kind === 'solid');
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[i + k]);
        hi[k] = Math.max(hi[k], p[i + k]);
      }
    }
    return { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
  };
  window.__onScreen = () => viewport.screenPositionOf(window.__centre());
  window.__changes = 0;
  viewport.onCameraChange(() => (window.__changes += 1));

  // Settled and framed before anything is measured.
  await sleep(600);
  viewport.isometricView();
  await sleep(300);
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};
const fmt = (n) => n.toFixed(3);

// ------------------------------------------------------------- the button

const button = await page.evaluate(() => {
  const found = document.querySelector('.toolbar-actions .tool-button[aria-label="3D Mouse"]');
  if (found === null) return null;
  const rect = found.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  // Inside the window, too: an overflowing action row clips the last button.
  const inside = rect.right <= window.innerWidth && rect.right <= found.parentElement.getBoundingClientRect().right + 1;
  return { lit: found.classList.contains('is-on'), reachable: hit !== null && found.contains(hit) && inside, x, y };
});
check(
  'a 3D Mouse button, lit while connected',
  button !== null && button.reachable && button.lit,
  JSON.stringify(button),
);

// ------------------------------------------------------------------- pan

let before = await page.evaluate(() => window.__onScreen());
await page.evaluate(() => window.__hold([300, 0, 0, 0, 0, 0]));
let after = await page.evaluate(() => window.__onScreen());
check(
  'pushing the cap right moves the model right',
  after.x - before.x > 40 && Math.abs(after.y - before.y) < 3,
  `dx ${fmt(after.x - before.x)} dy ${fmt(after.y - before.y)} px`,
);

before = after;
// Raw z points down: lifting the cap is negative.
await page.evaluate(() => window.__hold([0, 0, -300, 0, 0, 0]));
after = await page.evaluate(() => window.__onScreen());
check(
  'lifting the cap moves the model up',
  before.y - after.y > 40 && Math.abs(after.x - before.x) < 3,
  `dx ${fmt(after.x - before.x)} dy ${fmt(after.y - before.y)} px`,
);

// ------------------------------------------------------------------ zoom

let pose = await page.evaluate(() => window.__pose());
const changes = await page.evaluate(() => window.__changes);
// Raw y points towards the person: pushing away is negative.
await page.evaluate(() => window.__hold([0, -300, 0, 0, 0, 0]));
let next = await page.evaluate(() => window.__pose());
const heard = (await page.evaluate(() => window.__changes)) - changes;
check(
  'pushing the cap away zooms out',
  next.zoom < pose.zoom * 0.8,
  `zoom ${fmt(pose.zoom)} → ${fmt(next.zoom)}`,
);
check('and what is drawn in pixels hears about it', heard > 3, `${heard} camera changes`);

pose = next;
await page.evaluate(() => window.__hold([0, 300, 0, 0, 0, 0]));
next = await page.evaluate(() => window.__pose());
check('pulling it back zooms in', next.zoom > pose.zoom * 1.2, `zoom ${fmt(pose.zoom)} → ${fmt(next.zoom)}`);

pose = await page.evaluate(() => window.__pose());
await page.evaluate(() => window.__hold([0, -300, 0, 90, 0, 0]));
next = await page.evaluate(() => window.__pose());
check(
  'a push forward that also tips the cap only zooms',
  next.zoom < pose.zoom * 0.8 && Math.abs(next.polar - pose.polar) < 1e-3,
  `zoom ${fmt(pose.zoom)} → ${fmt(next.zoom)}, polar ${fmt(next.polar - pose.polar)}`,
);
await page.evaluate(() => window.__hold([0, 300, 0, 0, 0, 0], 300));

// ----------------------------------------------------------- smoothness

// A cap held still with a few counts of noise on it, reports at 125 Hz: the
// zoom's rate from frame to frame should barely vary.
const steadiness = await page.evaluate(async () => {
  const camera = window.wirecad.viewport.camera;
  let flip = 0;
  const noisy = setInterval(() => {
    flip += 1;
    window.__send(1, [0, -200 + (flip % 2 ? 12 : -12), 0, 0, 0, 0]);
  }, 8);
  await new Promise((r) => setTimeout(r, 300));
  const rates = [];
  let last = camera.zoom;
  let lastTime = null;
  await new Promise((resolve) => {
    // Timed by the frame's own timestamp, which is what the view steps by;
    // the clock read inside the callback wanders with the renderer's load.
    const frame = (now) => {
      const dt = lastTime === null ? 0 : (now - lastTime) / 1000;
      if (dt > 0) rates.push(Math.log(last / camera.zoom) / dt);
      last = camera.zoom;
      lastTime = now;
      if (rates.length < 30) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
  clearInterval(noisy);
  window.__send(1, [0, 0, 0, 0, 0, 0]);
  await new Promise((r) => setTimeout(r, 500));
  window.__hold([0, 300, 0, 0, 0, 0], 400);
  await new Promise((r) => setTimeout(r, 1000));
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const spread = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
  return { mean, spread };
});
check(
  'a steady push with noisy reports zooms at a steady rate',
  steadiness.mean > 0.2 && steadiness.spread / steadiness.mean < 0.1,
  `rate ${fmt(steadiness.mean)}/s, spread ${fmt((100 * steadiness.spread) / steadiness.mean)}%`,
);

// --------------------------------------------------------------- rotation

pose = next;
// Raw z points down, so anticlockwise from above is negative about it.
await page.evaluate(() => window.__hold([0, 0, 0, 0, 0, -300]));
next = await page.evaluate(() => window.__pose());
let turned = next.azimuth - pose.azimuth;
turned = Math.atan2(Math.sin(turned), Math.cos(turned));
check(
  'twisting anticlockwise turns the model anticlockwise',
  // The model turning one way is the camera going round the other.
  turned < -0.2 && Math.abs(next.polar - pose.polar) < 0.01,
  `camera azimuth ${fmt(turned)} rad, polar ${fmt(next.polar - pose.polar)}`,
);
check(
  'about the point the view orbits',
  next.target.every((v, i) => Math.abs(v - pose.target[i]) < 1e-6),
  next.target.map(fmt).join(','),
);

pose = next;
await page.evaluate(() => window.__hold([0, 0, 0, 300, 0, 0]));
next = await page.evaluate(() => window.__pose());
check(
  'tipping the top towards you shows more of the top',
  next.polar < pose.polar - 0.2,
  `polar ${fmt(pose.polar)} → ${fmt(next.polar)}`,
);

// Held far longer than it takes to reach the top: stops short, no flip.
await page.evaluate(() => window.__hold([0, 0, 0, 300, 0, 0], 2500));
next = await page.evaluate(() => window.__pose());
const upright = await page.evaluate(() => {
  const camera = window.wirecad.viewport.camera;
  camera.updateMatrixWorld();
  const right = new camera.position.constructor().setFromMatrixColumn(camera.matrixWorld, 0);
  return right.z;
});
check(
  'and stops short of straight down without flipping',
  next.polar > 0.005 && next.polar < 0.05 && Math.abs(upright) < 1e-6,
  `polar ${fmt(next.polar)}, camera right z ${upright.toExponential(1)}`,
);

// -------------------------------------------------------------- buttons

await page.evaluate(() => window.__hold([300, 0, 300, 0, 0, 0], 600));
await page.evaluate(() => window.__press(0b01));
next = await page.evaluate(() => window.__pose());
const iso = 1 / Math.sqrt(3);
check(
  'the first button goes to the isometric view',
  Math.abs(next.direction[0] - iso) < 1e-3 &&
    Math.abs(next.direction[1] + iso) < 1e-3 &&
    Math.abs(next.direction[2] - iso) < 1e-3,
  next.direction.map(fmt).join(','),
);

await page.evaluate(() => window.__hold([0, 0, 0, 0, 0, -300], 300));
await page.evaluate(() => window.__hold([300, -300, 0, 0, 0, 0], 600));
const turnedPose = await page.evaluate(() => window.__pose());
await page.evaluate(() => window.__press(0b10));
next = await page.evaluate(() => window.__pose());
const centre = await page.evaluate(() => window.__centre());
const onScreen = await page.evaluate(() => window.__onScreen());
check(
  'the second fits the model without turning it',
  next.direction.every((v, i) => Math.abs(v - turnedPose.direction[i]) < 1e-6) &&
    Math.abs(next.target[0] - centre.x) < 1e-6 &&
    Math.abs(next.target[2] - centre.z) < 1e-6 &&
    next.zoom === 1,
  `centre on screen ${fmt(onScreen.x)},${fmt(onScreen.y)}`,
);
if (shots !== undefined) await page.screenshot({ path: `${shots}/spacemouse-fit.png` });

// ------------------------------------------------------------- sketching

const sketching = await page.evaluate(async () => {
  const { viewport } = window.wirecad;
  viewport.alignToPlane({
    kind: 'plane',
    origin: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 },
  });
  await new Promise((r) => setTimeout(r, 200));
  const start = window.__pose();
  await window.__hold([0, 0, 0, 300, 0, -300]);
  const twisted = window.__pose();
  await window.__hold([300, 0, 0, 0, 0, 0]);
  const panned = window.__pose();
  viewport.releasePlaneAlignment();
  return { start, twisted, panned };
});
check(
  'while sketching the view stays square to the plane',
  sketching.twisted.direction.every((v, i) => Math.abs(v - sketching.start.direction[i]) < 1e-9),
  sketching.twisted.direction.map(fmt).join(','),
);
check(
  'but still pans',
  Math.abs(sketching.panned.target[0] - sketching.twisted.target[0]) > 1,
  `target x ${fmt(sketching.twisted.target[0])} → ${fmt(sketching.panned.target[0])}`,
);

// -------------------------------------------------------------- settings

await page.mouse.click(button.x, button.y);
await page.waitForTimeout(200);
const menu = await page.evaluate(() =>
  [...document.querySelectorAll('.menu .menu-item')].map((item) => item.dataset.action),
);
check(
  'clicking the lit button opens its settings',
  ['faster', 'slower', 'invert-pan', 'invert-zoom', 'invert-rotate', 'disconnect'].every((a) =>
    menu.includes(a),
  ),
  menu.join(','),
);
if (shots !== undefined) await page.screenshot({ path: `${shots}/spacemouse-menu.png` });
await page.locator('.menu-item[data-action="invert-zoom"]').click();
pose = await page.evaluate(() => window.__pose());
await page.evaluate(() => window.__hold([0, -300, 0, 0, 0, 0]));
next = await page.evaluate(() => window.__pose());
const stored = await page.evaluate(() => window.localStorage.getItem('wirecad.spacemouse'));
check(
  'inverting zoom makes pushing away zoom in, and is remembered',
  next.zoom > pose.zoom * 1.2 && stored !== null && JSON.parse(stored).invertZoom === true,
  `zoom ${fmt(pose.zoom)} → ${fmt(next.zoom)}; stored ${stored}`,
);

// ------------------------------------------- the driver's own scrolling

// 3DxWare turns a push into wheel events of its own. Those arriving while the
// cap is moving are dropped; a wheel turned with the cap at rest still zooms.
const wheel = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { viewport } = window.wirecad;
  const canvas = viewport.canvas;
  const rect = canvas.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height * 0.3;
  if (document.elementFromPoint(x, y) !== canvas) return { error: 'wheel would miss the canvas' };
  const spin = () =>
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 120, clientX: x, clientY: y, bubbles: true, cancelable: true }),
    );

  // A sideways push: it pans, so any change of zoom is the wheel's.
  window.__send(1, [120, 0, 0, 0, 0, 0]);
  await sleep(50);
  const before = viewport.camera.zoom;
  for (let i = 0; i < 5; i++) {
    spin();
    await sleep(30);
  }
  await sleep(150);
  const whileMoving = viewport.camera.zoom;
  window.__send(1, [0, 0, 0, 0, 0, 0]);
  await sleep(600);

  const rested = viewport.camera.zoom;
  spin();
  await sleep(300);
  const afterRest = viewport.camera.zoom;
  return { before, whileMoving, rested, afterRest };
});
check(
  'the driver\'s wheel events are ignored while the cap moves',
  wheel.error === undefined && wheel.whileMoving === wheel.before,
  wheel.error ?? `zoom ${fmt(wheel.before)} → ${fmt(wheel.whileMoving)}`,
);
check(
  'and a wheel turned with the cap at rest still zooms',
  wheel.error === undefined && wheel.afterRest < wheel.rested * 0.98,
  wheel.error ?? `zoom ${fmt(wheel.rested)} → ${fmt(wheel.afterRest)}`,
);

// ------------------------------------------------------------ disconnected

const still = await page.evaluate(async () => {
  window.__send(1, [300, 300, 300, 300, 300, 300]);
  await window.wirecad.spaceMouse.disconnect();
  await new Promise((r) => setTimeout(r, 500));
  const start = window.__pose();
  await new Promise((r) => setTimeout(r, 300));
  const end = window.__pose();
  const lit = document
    .querySelector('.toolbar-actions .tool-button[aria-label="3D Mouse"]')
    ?.classList.contains('is-on');
  window.localStorage.removeItem('wirecad.spacemouse');
  return { moved: Math.hypot(...end.offset.map((v, i) => v - start.offset[i])), lit };
});
check(
  'disconnecting stops the view, cap held or not',
  still.moved < 1e-9 && still.lit === false,
  `moved ${still.moved}, lit ${still.lit}`,
);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
