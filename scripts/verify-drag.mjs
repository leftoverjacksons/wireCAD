/**
 * Checks that a sketch can be pushed around by hand: that dragging a point
 * moves it only as far as its rules allow, that a dimension can be dragged to
 * where it reads best, and that where a dimension is put decides whether it
 * measures a span or one of the two components that span covers.
 *
 *   npm run dev
 *   npm run verify:drag
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

/**
 * A wedge with a flat base, pinned at the origin and loose everywhere else. It
 * hangs below its base so that none of it sits under the toolbar, which floats
 * over the top of the drawing area.
 */
async function openWedge() {
  await page.evaluate(async () => {
    const { graph } = window.wirecad;
    graph.restore({ version: 1, nodes: [], edges: [] });
    graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
    graph.addNode('sketch.constrained', {
      id: 'sk',
      inputs: {
        points: [0, 0, 40, 0, 25, -20],
        entities: [
          ['line', 0, 1],
          ['line', 1, 2],
          ['line', 2, 0],
        ],
        constraints: [
          ['lockU', 0, 'originU'],
          ['lockV', 0, 'originV'],
          ['horizontal', 0],
        ],
        dims: ['originU', 0, 'originV', 0],
      },
    });
    graph.connect({ node: 'xy', port: 'plane' }, { node: 'sk', port: 'plane' });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    window.wirecad.select('sk');
  });

  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();
  const panel = page.locator('.sketch-panel');
  await panel.waitFor({ state: 'visible', timeout: 10_000 });
  return panel;
}

const solved = () => page.evaluate(() => window.wirecad.sketch.solvedPoints());
const screenOf = (u, v) => page.evaluate(([u, v]) => window.wirecad.screenOfSketch(u, v), [u, v]);
const screenOfPoint = async (index, du = 0, dv = 0) => {
  const points = await solved();
  return screenOf(points[index].u + du, points[index].v + dv);
};

/** What is under a point on the page, so a test never aims at its own toolbar. */
const whatIsAt = (at) =>
  page.evaluate(
    ([x, y]) => {
      const element = document.elementFromPoint(x, y);
      return element === null ? 'nothing' : `${element.tagName}.${element.className}`;
    },
    [at.x, at.y],
  );

async function onCanvas(at, what) {
  const element = await whatIsAt(at);
  if (!element.startsWith('CANVAS')) throw new Error(`${what} is over ${element}, not the drawing`);
  return at;
}

/** A press, a few steps of movement, and a release: a drag, not a click. */
async function drag(from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 6,
      from.y + ((to.y - from.y) * step) / 6,
    );
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
}

console.log('pushing the drawing around:');

const panel = await openWedge();

// Per-millimetre travel on screen, so a drag can be asked for in millimetres.
const origin = await screenOf(0, 0);
const along = await screenOf(10, 0);
const perMm = Math.hypot(along.x - origin.x, along.y - origin.y) / 10;

// The apex is held by nothing at all, so it goes where it is put.
const apexFrom = await onCanvas(await screenOfPoint(2), 'the apex');
const apexTo = await onCanvas(
  { x: apexFrom.x + 10 * perMm, y: apexFrom.y + 6 * perMm },
  'where the apex is going',
);
await drag(apexFrom, apexTo);
const afterApex = await solved();

check(
  'a loose point follows      ',
  Math.abs(afterApex[2].u - 35) < 1.5 && Math.abs(afterApex[2].v + 26) < 1.5,
  `apex at ${afterApex[2].u.toFixed(1)}, ${afterApex[2].v.toFixed(1)}, wanted 35, -26`,
);
check(
  'and the base stays put     ',
  Math.abs(afterApex[0].u) < 1e-6 && Math.abs(afterApex[1].v) < 1e-6,
  `P1 ${afterApex[0].u.toFixed(2)}, ${afterApex[0].v.toFixed(2)} · P2 v ${afterApex[1].v.toFixed(2)}`,
);

// The far end of the base is held horizontal, so only part of a diagonal drag
// can be honoured: it slides along and refuses to rise.
const endFrom = await onCanvas(await screenOfPoint(1), 'the end of the base');
const endTo = await onCanvas(
  { x: endFrom.x + 8 * perMm, y: endFrom.y - 12 * perMm },
  'where the base end is going',
);
await drag(endFrom, endTo);
const afterEnd = await solved();

check(
  'a held point slides only   ',
  Math.abs(afterEnd[1].u - 48) < 1.5 && Math.abs(afterEnd[1].v) < 0.01,
  `end at ${afterEnd[1].u.toFixed(1)}, ${afterEnd[1].v.toFixed(2)}, wanted 48, 0`,
);

// Dragging is one movement of the model, not one per pixel of travel.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
const undone = await solved();
check(
  'one drag is one undo       ',
  Math.abs(undone[1].u - 40) < 1.5,
  `back to ${undone[1].u.toFixed(1)}, wanted 40`,
);

console.log('');
console.log('what a placement means:');

await page.evaluate(() => window.wirecad.sketch.exit());
await openWedge();
await panel.getByRole('button', { name: 'Dimension', exact: true }).click();

// The sloping edge, which covers a width and a height as well as its own length.
const slope = await page.evaluate(() => {
  const points = window.wirecad.sketch.solvedPoints();
  return window.wirecad.screenOfSketch(
    (points[1].u + points[2].u) / 2,
    (points[1].v + points[2].v) / 2,
  );
});
await page.mouse.click(slope.x, slope.y);
await page.waitForTimeout(200);

const readKinds = async (du, dv) => {
  const at = await page.evaluate(
    ([du, dv]) => {
      const points = window.wirecad.sketch.solvedPoints();
      return window.wirecad.screenOfSketch(
        (points[1].u + points[2].u) / 2 + du,
        (points[1].v + points[2].v) / 2 + dv,
      );
    },
    [du, dv],
  );
  await onCanvas(at, `a placement ${du} by ${dv} from the slope`);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(150);
  return {
    at,
    active: await page.evaluate(
      () =>
        [...document.querySelectorAll('.sketch-dialogue .tool-button')]
          .filter((button) => button.classList.contains('is-active'))
          .map((button) => button.textContent)
          .join(',') || 'none',
    ),
    reads: await page.locator('.sketch-dialogue-value').innerText(),
  };
};

// Square out from the slope asks for the slope's own length.
const aligned = await readKinds(24, -18);
// Straight down from it asks for the width it covers.
const horizontal = await readKinds(0, -20);
// Off to one side asks for the height.
const vertical = await readKinds(26, 0);

check('square out is the length  ', aligned.active === 'Aligned', `${aligned.active} · ${aligned.reads}`);
check('below it is the width     ', horizontal.active === 'Horizontal', `${horizontal.active} · ${horizontal.reads}`);
check('beside it is the height   ', vertical.active === 'Vertical', `${vertical.active} · ${vertical.reads}`);
check(
  'and each reads its own way',
  horizontal.reads === '15 mm' && vertical.reads === '20 mm' && aligned.reads === '25 mm',
  `${aligned.reads} / ${horizontal.reads} / ${vertical.reads}`,
);

// Put it below, where it means the width, and type a number over it.
await page.mouse.move(horizontal.at.x, horizontal.at.y);
await page.mouse.click(horizontal.at.x, horizontal.at.y);
await page.waitForTimeout(400);
const placed = await page.evaluate(() => ({
  points: window.wirecad.sketch.solvedPoints(),
  kinds: (window.wirecad.graph.inputValue('sk', 'constraints') ?? []).map((row) => row[0]),
  places: window.wirecad.graph.inputValue('sk', 'places') ?? [],
  labels: [...document.querySelectorAll('.sketch-label-field')].map((field) => field.value),
}));

check(
  'placing it moves nothing   ',
  placed.points.every(
    (point, index) =>
      Math.abs(point.u - [0, 40, 25][index]) < 1e-6 &&
      Math.abs(point.v - [0, 0, -20][index]) < 1e-6,
  ),
  placed.points.map((p) => `${p.u.toFixed(1)},${p.v.toFixed(1)}`).join(' · '),
);
check(
  'the placement is the kind  ',
  placed.kinds.includes('horizontalDistance'),
  placed.kinds.join(','),
);
check(
  'and it is remembered where ',
  placed.places.length === 3 && placed.places[0] === 'width1',
  placed.places.join(',') || 'nowhere',
);

console.log('');
console.log('moving a dimension:');

// Take it by its number and put it somewhere else entirely.
const label = page.locator('.sketch-label').filter({ has: page.locator('.sketch-label-field') }).first();
const box = await label.boundingBox();
const before = await page.evaluate(() => ({
  points: window.wirecad.sketch.solvedPoints(),
  places: window.wirecad.graph.inputValue('sk', 'places') ?? [],
}));

const labelFrom = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await drag(labelFrom, await onCanvas({ x: labelFrom.x + 50, y: labelFrom.y - 60 }, 'the new place'));

const after = await page.evaluate(() => ({
  points: window.wirecad.sketch.solvedPoints(),
  places: window.wirecad.graph.inputValue('sk', 'places') ?? [],
  box: document.querySelector('.sketch-label')?.getBoundingClientRect().top ?? 0,
}));

check(
  'the number moves with it   ',
  Math.abs(after.places[1] - before.places[1]) > 1 || Math.abs(after.places[2] - before.places[2]) > 1,
  `${before.places.slice(1).map((n) => n.toFixed(1))} → ${after.places.slice(1).map((n) => n.toFixed(1))}`,
);
check(
  'and the shape does not     ',
  after.points.every(
    (point, index) =>
      Math.abs(point.u - before.points[index].u) < 1e-9 &&
      Math.abs(point.v - before.points[index].v) < 1e-9,
  ),
  'every point where it was',
);

// It has to survive being written down and read back.
await panel.getByRole('button', { name: 'Finish', exact: true }).click();
await page.waitForTimeout(300);
await page.evaluate(() => window.wirecad.select('sk'));
await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();
await page.locator('.sketch-panel').waitFor({ state: 'visible', timeout: 10_000 });
await page.waitForTimeout(400);

const reopened = await page.evaluate(() => window.wirecad.graph.inputValue('sk', 'places') ?? []);
check(
  'and it comes back placed   ',
  reopened.length === 3 && Math.abs(reopened[1] - after.places[1]) < 1e-6,
  reopened.join(','),
);

await page.screenshot({ path: 'drag.png' });

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
