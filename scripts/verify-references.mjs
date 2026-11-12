/**
 * Checks that a sketch on a face can be dimensioned to the body it sits on:
 * that clicking an edge of the body lays it into the sketch with nothing asked,
 * that a dimension to it moves the drawing and not the body, and that the
 * drawing follows the body when the body changes underneath it.
 *
 *   npm run dev
 *   npm run verify:references
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
    const before = window.wirecad.solves();
    window.wirecad.solve();
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (window.wirecad.solves() <= before) continue;
      const seen = window.wirecad.solves();
      await new Promise((r) => setTimeout(r, 300));
      if (window.wirecad.solves() === seen) return;
    }
    throw new Error('solve did not settle');
  };
  /** The middle of what a node is drawn as, in model units. */
  window.__centreOf = (nodeId) => {
    const mesh = window.wirecad.meshes().find((entry) => entry.nodeId === nodeId);
    if (mesh === undefined) return null;
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        low[axis] = Math.min(low[axis], mesh.positions[i + axis]);
        high[axis] = Math.max(high[axis], mesh.positions[i + axis]);
      }
    }
    return low.map((value, axis) => (value + high[axis]) / 2);
  };
});

// The starter block, 60 by 40 with a bore through its middle, and a small
// circle sketched on its top face, pinned only by where it was drawn.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  const bore = graph.allNodes().find((node) => node.label === 'Bore');

  graph.addNode('face.plane', { id: 'top', inputs: { nx: 0, ny: 0, nz: 1, rank: 0 } });
  graph.connect({ node: bore.id, port: 'solid' }, { node: 'top', port: 'solid' });
  graph.addNode('sketch.constrained', {
    id: 'sk',
    label: 'Hole',
    inputs: {
      // A circle, and a loose upright line to be set off the body's edge. The
      // line is taken out again before the profile is built: nothing closes it.
      points: [-15, -8, -20, 5, -20, 15],
      entities: [
        ['circle', 0, 4],
        ['line', 1, 2],
      ],
      constraints: [
        ['lockU', 0, 'originU'],
        ['lockV', 0, 'originV'],
        ['vertical', 1],
      ],
      dims: ['originU', -15, 'originV', -8],
      d_originU: -15,
      d_originV: -8,
    },
  });
  graph.connect({ node: 'top', port: 'plane' }, { node: 'sk', port: 'plane' });
  await window.__settle();
  window.wirecad.select('sk');
});

await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();
const panel = page.locator('.sketch-panel');
await panel.waitFor({ state: 'visible', timeout: 10_000 });
await page.waitForTimeout(1200);

const screenOf = (u, v) => page.evaluate(([u, v]) => window.wirecad.screenOfSketch(u, v), [u, v]);
const solved = () => page.evaluate(() => window.wirecad.sketch.solvedPoints());
const stored = () =>
  page.evaluate(() => {
    const node = window.wirecad.graph.getNode('sk');
    return {
      constraints: node.inputs.constraints,
      refs: node.inputs.refs ?? [],
      entities: node.inputs.entities,
      dims: node.inputs.dims,
      body: window.wirecad.graph.incomingEdge('sk', 'body')?.from.node ?? null,
    };
  });

/** A click on the drawing, refused if anything but the canvas is under it. */
async function clickAt(u, v, what) {
  const at = await screenOf(u, v);
  const element = await page.evaluate(
    ([x, y]) => {
      const found = document.elementFromPoint(x, y);
      return found === null ? 'nothing' : `${found.tagName}.${found.className}`;
    },
    [at.x, at.y],
  );
  if (!element.startsWith('CANVAS')) throw new Error(`${what} is over ${element}, not the drawing`);
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function typeDimension(value) {
  await page.keyboard.type(String(value));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

const tool = (name) => panel.getByRole('button', { name, exact: true }).click();
const boreId = await page.evaluate(
  () => window.wirecad.graph.allNodes().find((node) => node.label === 'Bore').id,
);

console.log('measuring from the body:');

// The top face's own axes start at its middle, so the block's left edge is at
// U = -30, its bottom edge at V = -20, and the bore at the origin.
await tool('Dimension');
await clickAt(-30, 6, 'the left edge of the block');
let now = await stored();
check('clicking an edge of the body lays it into the sketch', now.refs.length === 1, `${now.refs.length} reference(s)`);
check('and wires the sketch to the body it came from', now.body === boreId, String(now.body));
check(
  'as a reference line, which bounds nothing',
  now.entities.some((row) => row[0] === 'line' && row[3] === 'reference'),
);
if (shots) await page.screenshot({ path: `${shots}/references-1-edge.png` });

await clickAt(-11, -8, 'the rim of the drawn circle');
await clickAt(-22, -14, 'somewhere to put the dimension');
now = await stored();
const offset = now.constraints.find((row) => row[0] === 'lineDistance');
check('an edge and then a circle is the distance between them', offset !== undefined);
const offsetValue = offset === undefined ? NaN : now.dims[now.dims.indexOf(offset[3]) + 1];
check('which starts at what it measures', near(offsetValue, 15), `${offsetValue} mm`);
check(
  'and the origin lock gives way to it',
  !now.constraints.some((row) => row[0] === 'lockU'),
  JSON.stringify(now.constraints.map((row) => row[0])),
);

await typeDimension(20);
let points = await solved();
check('typing a number moves the circle', near(points[0].u, -10), `U = ${points[0].u}`);
check('and leaves the edge where the body has it', near(points[3].u, -30) && near(points[4].u, -30));

// The bore: clicking its rim means its centre.
await clickAt(8, 0, 'the rim of the bore');
now = await stored();
check('clicking the rim of a bore refers to its centre', now.refs.some((row) => row[0] === 'centre'));
points = await solved();
const boreCentre = points[points.length - 1];
check('which sits where the bore is', near(boreCentre.u, 0) && near(boreCentre.v, 0), JSON.stringify(boreCentre));

await clickAt(-10, -8, 'the centre of the drawn circle');
// Off to the side of the pair, which asks for the height between them.
await clickAt(14, -4, 'somewhere to put the second dimension');
now = await stored();
const height = now.constraints.find((row) => row[0] === 'verticalDistance');
check('a dimension from the bore to the circle is made', height !== undefined, JSON.stringify(now.constraints));
check('and the other origin lock gives way too', !now.constraints.some((row) => row[0] === 'lockV'));
await typeDimension(12);
points = await solved();
check('typing it moves the circle the other way', near(points[0].v, -12), `V = ${points[0].v}`);
if (shots) await page.screenshot({ path: `${shots}/references-2-dimensioned.png` });

console.log('offsets and shared numbers:');

// Two lines that run the same way: the drawn one, and the body's left edge.
await clickAt(-20, 10, 'the drawn line');
await clickAt(-30, 14, 'the left edge, already in the sketch');
await clickAt(-25, 18, 'somewhere to put the gap');
now = await stored();
const gap = now.constraints.filter((row) => row[0] === 'lineDistance')[1];
check('two lines that run the same way give the gap between them', gap !== undefined, JSON.stringify(now.constraints));
check(
  'measured from the body\u2019s edge to the drawn line',
  gap !== undefined && now.entities[gap[2]][3] === 'reference' && (gap[1] === 1 || gap[1] === 2),
  JSON.stringify(gap),
);
check(
  'without repeating that they are parallel, which upright already says',
  !now.constraints.some((row) => row[0] === 'parallel'),
);
await typeDimension(14);
points = await solved();
check('typing it sets the line off the edge', near(points[1].u, -16) && near(points[2].u, -16), `U = ${points[1].u}`);

// The same against an edge not yet in the sketch: the right side of the block.
await clickAt(-16, 10, 'the drawn line again');
await clickAt(30, 14, 'the right edge of the block');
now = await stored();
check('a body edge can be the second line without being laid in first', now.refs.length === 3, `${now.refs.length} reference(s)`);
await clickAt(8, 17, 'somewhere to put the second gap');
now = await stored();
check('and the gap to it is measured', now.constraints.filter((row) => row[0] === 'lineDistance').length === 3);
check('which repeats the first, and says so', (await panel.locator('.sketch-hint').innerText()).includes('repeats'));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
// Taken back out: one gap is enough to hold the line.
await tool('Select');
{
  const at = await page.evaluate(() => {
    const field = [...document.querySelectorAll('.sketch-label-field')].at(-1);
    const box = field.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
}
now = await stored();
check('a dimension picked by its number and deleted is gone', now.constraints.filter((row) => row[0] === 'lineDistance').length === 2);

// The line's own length, made the same number as the circle's offset by
// clicking that dimension while this one is open for typing.
await tool('Dimension');
await clickAt(-16, 10, 'the drawn line once more');
await clickAt(-4, 12, 'somewhere to put its length');
now = await stored();
check('a length is placed, its number open', now.constraints.some((row) => row[0] === 'distance'));
{
  const at = await page.evaluate(() => {
    const field = document.querySelector('.sketch-label-field[data-dimension="offset1"]');
    const box = field.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
}
now = await stored();
const length = now.constraints.find((row) => row[0] === 'distance');
check('clicking another dimension gives this one that number', length?.[3] === 'offset1', JSON.stringify(length));
check('and the number it had is gone', !now.dims.includes('length1'), JSON.stringify(now.dims));
points = await solved();
check(
  'so the line is as long as the circle is far from the edge',
  near(Math.abs(points[2].v - points[1].v), 20),
  `${Math.abs(points[2].v - points[1].v)} mm`,
);
check(
  'both numbers are marked as shared',
  (await page.locator('.sketch-label-field.is-linked').count()) === 2,
);
if (shots) await page.screenshot({ path: `${shots}/references-4-linked.png` });

// Changing the shared number changes both.
await page.evaluate(() => {
  const field = document.querySelector('.sketch-label-field[data-dimension="offset1"]');
  field.focus();
  field.value = '22';
  field.dispatchEvent(new Event('change'));
  field.blur();
});
await page.waitForTimeout(400);
points = await solved();
check(
  'changing one changes the other',
  near(points[0].u - points[3].u, 22) && near(Math.abs(points[2].v - points[1].v), 22),
  JSON.stringify(points.slice(0, 4)),
);
await page.evaluate(() => {
  const field = document.querySelector('.sketch-label-field[data-dimension="offset1"]');
  field.focus();
  field.value = '20';
  field.dispatchEvent(new Event('change'));
  field.blur();
});
await page.waitForTimeout(400);

// The loose line goes, and what was measured to it with it.
await tool('Select');
points = await solved();
await clickAt(points[1].u, (points[1].v + points[2].v) / 2, 'the drawn line, to delete it');
await page.keyboard.press('Delete');
await page.waitForTimeout(300);
now = await stored();
check(
  'deleting the line leaves the circle\u2019s dimensions alone',
  now.entities.filter((row) => row[0] === 'line' && row[3] !== 'reference').length === 0 &&
    now.constraints.some((row) => row[3] === 'offset1') &&
    now.constraints.some((row) => row[0] === 'verticalDistance'),
  JSON.stringify(now.constraints),
);

// An edge clicked and never measured from does not stay.
await tool('Select');
await clickAt(30, 6, 'the right edge of the block');
now = await stored();
check('an edge can be picked with Select as well', now.refs.length === 3, `${now.refs.length} reference(s)`);

await panel.getByRole('button', { name: 'Finish', exact: true }).click();
await page.evaluate(() => window.__settle());
now = await stored();
check('an edge nothing measured from is taken back out on leaving', now.refs.length === 2, `${now.refs.length} reference(s)`);

const report = () =>
  page.evaluate(() => window.wirecad.reports().find((entry) => entry.nodeId === 'sk'));
let state = await report();
check('the kernel builds the profile', state?.error === undefined, state?.error ?? state?.status);

// In the model's own axes the circle is 20 mm in from the left edge and 12 mm
// below the bore.
let centre = await page.evaluate(() => window.__centreOf('sk'));
check(
  'where the dimensions put it',
  centre !== null && near(centre[0], 20, 0.05) && near(centre[1], 8, 0.05),
  JSON.stringify(centre),
);

console.log('following the body:');

// Widening the block moves the middle of its top face, and with it the axes
// the sketch is drawn in. A sketch that only remembered coordinates would move
// with them; one that measures from the edge stays 20 mm from the edge.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const profile = graph.allNodes().find((node) => node.label === 'Body profile');
  graph.setInput(profile.id, 'width', 80);
  await window.__settle();
});
state = await report();
check('the sketch still solves on the wider block', state?.error === undefined, state?.error ?? state?.status);
centre = await page.evaluate(() => window.__centreOf('sk'));
check(
  'and the circle is still 20 mm from the left edge',
  centre !== null && near(centre[0], 20, 0.05) && near(centre[1], 8, 0.05),
  JSON.stringify(centre),
);

// Moving the bore takes the circle with it, 12 mm below.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const profile = graph.allNodes().find((node) => node.label === 'Bore profile');
  graph.setInput(profile.id, 'v', 26);
  await window.__settle();
});
centre = await page.evaluate(() => window.__centreOf('sk'));
check(
  'and moving the bore takes the circle with it',
  centre !== null && near(centre[0], 20, 0.05) && near(centre[1], 14, 0.05),
  JSON.stringify(centre),
);

console.log('coming back to it:');

// Once the sketch has been used, the body it measures from is no longer what is
// on screen: the cut made from the sketch has replaced it. Reopened, that body
// has to come back to be clicked.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const bore = graph.allNodes().find((node) => node.label === 'Bore');
  graph.addNode('solid.extrude', { id: 'pocket', inputs: { distance: -5, operation: 'Cut' } });
  graph.connect({ node: 'sk', port: 'profile' }, { node: 'pocket', port: 'profile' });
  graph.connect({ node: bore.id, port: 'solid' }, { node: 'pocket', port: 'target' });
  await window.__settle();
  window.wirecad.select('sk');
});
state = await page.evaluate(() => window.wirecad.reports().find((entry) => entry.nodeId === 'pocket'));
check('a pocket cut from the sketch builds', state?.error === undefined, state?.error ?? state?.status);
check(
  'and replaces the body the sketch measures from',
  !(await page.evaluate((id) => window.wirecad.visible().includes(id), boreId)),
);

await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();
await panel.waitFor({ state: 'visible', timeout: 10_000 });
await page.evaluate(() => window.__settle());
await page.waitForTimeout(600);
check(
  'reopening the sketch brings that body back',
  await page.evaluate((id) => window.wirecad.visible().includes(id), boreId),
);
points = await solved();
check(
  'with the circle where its dimensions hold it',
  near(points[0].u - points[1].u, 20) && near(points[points.length - 1].v - points[0].v, 12),
  JSON.stringify(points),
);

await tool('Dimension');
// The back edge of the wider block, whose face now runs from V = -20 to 20.
await clickAt(10, 20, 'the back edge of the block');
now = await stored();
check('and its edges can still be clicked', now.refs.length === 3, `${now.refs.length} reference(s)`);
if (shots) await page.screenshot({ path: `${shots}/references-3-reopened.png` });
await page.keyboard.press('Escape');
await panel.getByRole('button', { name: 'Finish', exact: true }).click();
await page.evaluate(() => window.__settle());
check(
  'leaving lets the body go again',
  !(await page.evaluate((id) => window.wirecad.visible().includes(id), boreId)),
);

// A reference to an edge that is no longer there says so.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const edge = graph.incomingEdge('sk', 'body');
  graph.disconnect(edge.id);
  await window.__settle();
});
state = await report();
check(
  'a sketch that measures from a body it no longer has says so',
  typeof state?.error === 'string' && state.error.includes('measures from a body'),
  state?.error ?? state?.status,
);

check('nothing threw on the page', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
