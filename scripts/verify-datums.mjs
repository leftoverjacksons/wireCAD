/**
 * Checks the three planes through the origin: that they are drawn, that
 * clicking one means that plane, that a body in front of one takes the click
 * instead, and that a plane picked this way feeds whatever is asking for one.
 *
 *   npm run dev
 *   npm run verify:datums
 */
import { chromium } from 'playwright';

const url = process.env.WIRECAD_URL ?? 'http://localhost:5173/';
const executablePath = process.env.CHROMIUM_PATH;

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

let failures = 0;
const check = (name, ok, extra) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
};

// The starter model: a bored block in the +X +Y +Z octant, and no plane node
// anywhere, so every plane here is one the squares made.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  await new Promise((resolve) => setTimeout(resolve, 3000));
});
await page.waitForTimeout(1500);

const planeNodes = () =>
  page.evaluate(() =>
    window.wirecad.graph
      .allNodes()
      .filter((node) => node.type.startsWith('plane.'))
      .map((node) => node.type),
  );

const at = (x, y, z) =>
  page.evaluate(
    ([x, y, z]) => window.wirecad.viewport.screenPositionOf({ x, y, z }),
    [x, y, z],
  );

/**
 * A point on screen that the view itself says is on an origin square, with the
 * canvas exposed there and the point well inside the square's edges.
 *
 * Aiming at a hand-picked model point is not enough: the squares are only 20 mm
 * across round a starter block, and a corner of one is also a corner of the
 * block's silhouette, so whether such a click counts was decided by how a
 * pixel happened to round — and changed when the framing did.
 */
const pointOnSquare = (axis, place) =>
  page.evaluate(
    ([axis, place]) => {
      const view = window.wirecad.viewport;
      for (let a = -8; a <= 8; a += 1) {
        for (let b = -8; b <= 8; b += 1) {
          const model =
            place === 'xy' ? { x: a, y: b, z: 0 } : place === 'yz' ? { x: 0, y: a, z: b } : { x: a, y: 0, z: b };
          const at = view.screenPositionOf(model);
          if (document.elementFromPoint(at.x, at.y) !== view.canvas) continue;
          if (view.datumAt(at.x, at.y) === axis) return at;
        }
      }
      return null;
    },
    [axis, place],
  );

console.log('the origin planes:');
check('a fresh model has none    ', (await planeNodes()).length === 0, (await planeNodes()).join(',') || 'no plane nodes');

// Somewhere on the XY square the block is not in front of.
const onXY = await pointOnSquare('xy', 'xy');
if (onXY === null) throw new Error('no part of the XY square is showing to click');
await page.mouse.click(onXY.x, onXY.y);
await page.waitForTimeout(600);

check('clicking one makes it    ', (await planeNodes()).join(',') === 'plane.xy', (await planeNodes()).join(',') || 'none');
check(
  'and it is what is selected',
  await page.evaluate(() => {
    const selected = document.querySelector('.node-selected .node-title');
    return selected?.textContent ?? '';
  }).then((label) => label.includes('XY')),
  await page.evaluate(() => document.querySelector('.node-selected .node-title')?.textContent ?? 'nothing selected'),
);

// Again: the document already has that plane, so it is the one already there.
await page.mouse.click(onXY.x, onXY.y);
await page.waitForTimeout(500);
check('twice does not make two  ', (await planeNodes()).join(',') === 'plane.xy', (await planeNodes()).join(','));

// The XY plane runs under the block. Where the block is in front of it, the
// click belongs to the block.
const behind = await at(30, 20, 0);
await page.mouse.click(behind.x, behind.y);
await page.waitForTimeout(500);
check(
  'a body in front takes it ',
  (await planeNodes()).join(',') === 'plane.xy' &&
    (await page.evaluate(() => document.querySelector('.node-selected .node-title')?.textContent ?? '')) !== 'XY Plane',
  await page.evaluate(() => document.querySelector('.node-selected .node-title')?.textContent ?? 'nothing'),
);

console.log('');
console.log('showing what a plane node is:');

// A plane node makes no geometry. What it is responsible for is the plane, so
// selecting one has to show it — one of the three lights up the square already
// drawn for it, and anything else gets a square of its own where it actually is.
await page.evaluate(() => {
  const plane = window.wirecad.graph.allNodes().find((node) => node.type === 'plane.xy');
  window.wirecad.select(plane.id);
});
await page.waitForTimeout(400);
check(
  'a datum lights its square',
  (await page.evaluate(() => window.wirecad.viewport.selectedPlaneShown())) === 'xy',
  await page.evaluate(() => String(window.wirecad.viewport.selectedPlaneShown())),
);

await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const xy = graph.allNodes().find((node) => node.type === 'plane.xy');
  const offset = graph.addNode('plane.offset', { inputs: { distance: 35 } });
  graph.connect({ node: xy.id, port: 'plane' }, { node: offset.id, port: 'plane' });
  window.wirecad.solve();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  window.wirecad.select(offset.id);
});
await page.waitForTimeout(600);
check(
  'another gets one of its own',
  (await page.evaluate(() => window.wirecad.viewport.selectedPlaneShown())) === 'ghost',
  await page.evaluate(() => String(window.wirecad.viewport.selectedPlaneShown())),
);

await page.evaluate(() => {
  const body = window.wirecad.graph.allNodes().find((node) => node.label === 'Body');
  window.wirecad.select(body.id);
});
await page.waitForTimeout(400);
check(
  'and a body shows none     ',
  (await page.evaluate(() => window.wirecad.viewport.selectedPlaneShown())) === null,
  await page.evaluate(() => String(window.wirecad.viewport.selectedPlaneShown())),
);

console.log('');
console.log('sketching on one:');

await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Create Sketch', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible', timeout: 5_000 });

// The YZ square, wherever it is showing.
const onYZ = await pointOnSquare('yz', 'yz');
if (onYZ === null) throw new Error('no part of the YZ square is showing to click');
await page.mouse.click(onYZ.x, onYZ.y);
await page.waitForTimeout(600);

const armed = await page.evaluate(() => ({
  planes: window.wirecad.graph.allNodes().filter((node) => node.type.startsWith('plane.')).map((n) => n.type),
  operand: document.querySelector('.operand-value')?.textContent ?? '',
}));
check('the dialog takes it      ', armed.planes.includes('plane.yz'), armed.planes.join(','));

await page.getByRole('button', { name: 'Create', exact: true }).click();
await page.waitForTimeout(800);

const wiring = await page.evaluate(() => {
  const { graph } = window.wirecad;
  const sketch = graph.allNodes().find((node) => node.type === 'sketch.constrained');
  if (sketch === undefined) return 'no sketch';
  const edge = graph.incomingEdge(sketch.id, 'plane');
  if (edge === undefined) return 'sketch on nothing';
  return graph.requireNode(edge.from.node).type;
});
check('and the sketch sits on it', wiring === 'plane.yz', wiring);

// The squares are not drawn while a sketch has the view: three planes through
// the middle of what you are drawing are in the way rather than of use.
const whileSketching = await page.evaluate(() => window.wirecad.viewport.datumsShown());
await page.locator('.sketch-panel').getByRole('button', { name: 'Finish', exact: true }).click();
await page.waitForTimeout(600);
const afterwards = await page.evaluate(() => window.wirecad.viewport.datumsShown());

check('hidden while drawing     ', whileSketching === false, String(whileSketching));
check('and back again after     ', afterwards === true, String(afterwards));

if (pageErrors.length > 0) {
  failures += pageErrors.length;
  console.log('');
  for (const error of pageErrors) console.log(`page error: ${error}`);
} else {
  console.log('');
  console.log('no page errors');
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
