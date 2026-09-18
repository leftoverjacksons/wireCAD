/**
 * Checks that a sketch's relations show on the drawing as marks, that a mark
 * can be picked, and that Delete takes back whatever is picked — a relation by
 * its mark, a dimension by its number.
 *
 *   npm run dev
 *   npm run verify:glyphs
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

// A wedge hanging below its base, so none of it is under the floating toolbar.
// Its base is horizontal, its two slopes are equal, and its base is dimensioned.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  graph.addNode('sketch.constrained', {
    id: 'sk',
    inputs: {
      points: [0, 0, 40, 0, 20, -22],
      entities: [
        ['line', 0, 1],
        ['line', 1, 2],
        ['line', 2, 0],
      ],
      constraints: [
        ['lockU', 0, 'originU'],
        ['lockV', 0, 'originV'],
        ['horizontal', 0],
        ['equal', 1, 2],
        ['distance', 0, 1, 'length1'],
      ],
      dims: ['originU', 0, 'originV', 0, 'length1', 40],
      d_originU: 0,
      d_originV: 0,
      d_length1: 40,
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
await page.waitForTimeout(400);

console.log('marks on the drawing:');

const rules = await page.evaluate(() => window.wirecad.sketch.drawnRules());
const kinds = rules.map((rule) => rule.kind).sort();

check(
  'every relation is marked  ',
  kinds.join(',') === 'equal,equal,horizontal',
  kinds.join(',') || 'none',
);
check(
  'and a dimension is not    ',
  rules.every((rule) => rule.kind !== 'distance'),
  `${rules.length} marks for 5 rules`,
);

// The mark for the horizontal base sits off the base, not on it.
const horizontal = rules.find((rule) => rule.kind === 'horizontal');
check(
  'the mark sits off its edge',
  horizontal !== undefined && Math.abs(horizontal.at.v) > 1 && Math.abs(horizontal.at.u - 20) < 12,
  horizontal === undefined ? 'no mark' : `${horizontal.at.u.toFixed(1)}, ${horizontal.at.v.toFixed(1)}`,
);

console.log('');
console.log('picking and deleting:');

const screenOf = (u, v) => page.evaluate(([u, v]) => window.wirecad.screenOfSketch(u, v), [u, v]);
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

const freedomOf = async () =>
  Number(/(\d+) degree/.exec((await panel.locator('.sketch-status').innerText()) ?? '')?.[1] ?? '0');

const before = await freedomOf();
const markAt = await onCanvas(await screenOf(horizontal.at.u, horizontal.at.v), 'the horizontal mark');
await page.mouse.click(markAt.x, markAt.y);
await page.waitForTimeout(300);

const afterPick = await page.evaluate(() => ({
  rows: [...document.querySelectorAll('.sketch-row.is-picked')].map((row) =>
    row.querySelector('.sketch-row-label')?.textContent ?? '',
  ),
}));
check(
  'clicking a mark picks it  ',
  afterPick.rows.length === 1 && afterPick.rows[0].startsWith('Horizontal'),
  afterPick.rows.join(',') || 'nothing picked',
);

await page.keyboard.press('Delete');
await page.waitForTimeout(500);
const afterDelete = await page.evaluate(() => ({
  kinds: (window.wirecad.graph.inputValue('sk', 'constraints') ?? []).map((row) => row[0]),
  marks: window.wirecad.sketch.drawnRules().map((rule) => rule.kind),
}));
const loosened = await freedomOf();

check(
  'Delete takes the rule out ',
  !afterDelete.kinds.includes('horizontal'),
  afterDelete.kinds.join(','),
);
check(
  'the mark goes with it     ',
  afterDelete.marks.filter((kind) => kind === 'horizontal').length === 0,
  afterDelete.marks.join(',') || 'none',
);
check('and the sketch loosens    ', loosened === before + 1, `${before} → ${loosened} degrees of freedom`);

// A dimension is picked by its number, and Delete takes it away as well —
// along with the port it grew on the node.
const label = page.locator('.sketch-label-field').first();
await label.click();
await page.waitForTimeout(300);
const dimensionPicked = await page.evaluate(() => ({
  picked: document.querySelectorAll('.sketch-label-field.is-picked').length,
  focused: document.activeElement?.tagName ?? '',
}));
check(
  'clicking a number picks it',
  dimensionPicked.picked === 1 && dimensionPicked.focused !== 'INPUT',
  `${dimensionPicked.picked} picked, focus on ${dimensionPicked.focused}`,
);

await page.keyboard.press('Delete');
await page.waitForTimeout(600);
const withoutDimension = await page.evaluate(() => ({
  kinds: (window.wirecad.graph.inputValue('sk', 'constraints') ?? []).map((row) => row[0]),
  ports: window.wirecad.graph
    .schemaOf('sk')
    .inputs.filter((port) => port.hidden !== true)
    .map((port) => port.label),
  labels: document.querySelectorAll('.sketch-label-field').length,
}));
check(
  'and Delete takes it too   ',
  !withoutDimension.kinds.includes('distance') && withoutDimension.labels === 0,
  `${withoutDimension.kinds.join(',')} · ${withoutDimension.labels} numbers`,
);
check(
  'the port goes with it     ',
  !withoutDimension.ports.includes('length1'),
  withoutDimension.ports.join(','),
);

// Two clicks on a number is still how the number gets typed.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const again = page.locator('.sketch-label-field').first();
await again.dblclick();
await page.keyboard.type('55');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const typed = await page.evaluate(() => window.wirecad.graph.inputValue('sk', 'dims') ?? []);
check(
  'two clicks still type it  ',
  typed[typed.indexOf('length1') + 1] === 55,
  typed.join(','),
);

await page.screenshot({ path: 'glyphs.png', clip: { x: 290, y: 0, width: 990, height: 474 } });

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
