/**
 * Checks that an offset plane being set up is drawn where it will be, and
 * carries an arrow that sets its distance by dragging — from a datum plane and
 * from a face picked off a body.
 *
 *   npm run dev
 *   npm run verify:offset
 */
import { chromium } from 'playwright';

const url = process.env.WIRECAD_URL ?? 'http://localhost:5173/';
const executablePath = process.env.CHROMIUM_PATH;
const shots = process.env.WIRECAD_SHOTS;

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
  .locator('#kernel-status')
  .filter({ hasText: 'kernel ready' })
  .waitFor({ timeout: 180_000 });

let failures = 0;
function check(what, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}
const near = (a, b, slack = 1e-3) => Math.abs(a - b) <= slack;

await page.evaluate(() => {
  window.__settle = async () => {
    window.wirecad.solve();
    let seen = -1;
    let quiet = 0;
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const now = window.wirecad.solves();
      if (now === seen && !window.wirecad.pending()) quiet += 1;
      else quiet = 0;
      seen = now;
      if (quiet >= 6) return;
    }
    throw new Error('solve did not settle');
  };
  /** The plane square drawn for a plane that is not one of the three datums. */
  window.__square = () => {
    const ghost = window.wirecad.viewport.planeGhost;
    if (ghost === null || !ghost.visible) return null;
    const n = new window.wirecad.viewport.planeGhost.position.constructor(0, 0, 1).applyQuaternion(
      ghost.quaternion,
    );
    return { x: ghost.position.x, y: ghost.position.y, z: ghost.position.z, nx: n.x, ny: n.y, nz: n.z };
  };
});

const blockId = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  await window.__settle();
  return graph.allNodes().find((node) => node.label === 'Bore').id;
});

const dialog = page.locator('.feature-dialog');
const distanceField = () => dialog.locator('input.feature-number').first();

async function openOffset(selected) {
  await page.evaluate((id) => window.wirecad.select(id), selected);
  await page.getByRole('button', { name: 'Solid', exact: true }).click();
  await page.getByRole('button', { name: 'Offset Plane', exact: true }).click();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => window.__settle());
}

/** A drag from the arrow's head, refused if anything but the canvas is under it. */
async function dragArrow(dx, dy) {
  const head = await page.evaluate(() => window.wirecad.handleAt());
  if (head === null) throw new Error('there is no arrow to drag');
  const under = await page.evaluate(
    ([x, y]) => {
      const found = document.elementFromPoint(x, y);
      return found === null ? 'nothing' : `${found.tagName}.${found.className}`;
    },
    [head.x, head.y],
  );
  if (!under.startsWith('CANVAS')) throw new Error(`the arrow is under ${under}, not the view`);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x + dx, head.y + dy, { steps: 12 });
  await page.mouse.up();
  await page.evaluate(() => window.__settle());
}

console.log('offsetting a datum plane:');

await openOffset('xy');
let square = await page.evaluate(() => window.__square());
check('the plane being made is drawn before it is created', square !== null);
check('ten millimetres above the plane it offsets', square !== null && near(square.z, 10), JSON.stringify(square));
check('and lying flat, as that plane does', square !== null && near(Math.abs(square.nz), 1), JSON.stringify(square));
const head = await page.evaluate(() => window.wirecad.handleAt());
check('there is an arrow to drag', head !== null);
if (shots) await page.screenshot({ path: `${shots}/offset-1-preview.png` });

await distanceField().fill('25');
await page.evaluate(() => window.__settle());
square = await page.evaluate(() => window.__square());
check('typing a distance moves the drawn plane', square !== null && near(square.z, 25), JSON.stringify(square));

// Up the screen is up the Z axis in the opening isometric view.
await dragArrow(0, -70);
const dragged = Number(await distanceField().inputValue());
square = await page.evaluate(() => window.__square());
check('dragging the arrow up increases the distance', dragged > 30, `${dragged} mm`);
check('and the drawn plane follows the number', square !== null && near(square.z, dragged, 0.05), JSON.stringify(square));

await dragArrow(0, 140);
const lowered = Number(await distanceField().inputValue());
check('dragging it back down decreases it', lowered < dragged, `${lowered} mm`);
if (shots) await page.screenshot({ path: `${shots}/offset-2-dragged.png` });

await dialog.getByRole('button', { name: 'Create', exact: true }).click();
await page.evaluate(() => window.__settle());
const made = await page.evaluate(() => {
  const { graph } = window.wirecad;
  const node = graph.allNodes().find((entry) => entry.type === 'plane.offset');
  return node === undefined ? null : { id: node.id, distance: node.inputs.distance };
});
check('Create keeps the dragged distance', made !== null && near(made.distance, lowered), JSON.stringify(made));
square = await page.evaluate(() => window.__square());
check('and the new plane is still shown, now as the selection', square !== null && near(square.z, lowered, 0.05), JSON.stringify(square));

console.log('offsetting a face:');

// The block's front face, picked by clicking it: its plane faces -Y at Y = 0.
await page.evaluate(() => window.wirecad.select(null));
await page.getByRole('button', { name: 'Offset Plane', exact: true }).click();
await dialog.waitFor({ state: 'visible', timeout: 10_000 });
const front = await page.evaluate((id) => {
  const { viewport } = window.wirecad;
  const faces = viewport.facesOf(id);
  const face = faces.find((entry) => entry.planar && entry.normal.y < -0.99);
  return viewport.screenPositionOf(face.origin);
}, blockId);
await page.mouse.click(front.x, front.y);
await page.evaluate(() => window.__settle());
square = await page.evaluate(() => window.__square());
check('a picked face is offset outward from the face', square !== null && near(square.y, -10, 0.05), JSON.stringify(square));
check('standing as the face does', square !== null && near(Math.abs(square.ny), 1), JSON.stringify(square));
check('with an arrow to drag', (await page.evaluate(() => window.wirecad.handleAt())) !== null);
if (shots) await page.screenshot({ path: `${shots}/offset-3-face.png` });

await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
await page.evaluate(() => window.__settle());
square = await page.evaluate(() => window.__square());
check('Cancel takes the drawn plane away with it', square === null, JSON.stringify(square));

check('nothing threw on the page', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
