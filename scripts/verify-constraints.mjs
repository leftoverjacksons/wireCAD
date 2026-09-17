/**
 * Checks a constrained sketch end to end: that its dimensions appear as ports,
 * that solving them produces the geometry the numbers imply, and that an
 * impossible set of constraints is refused rather than approximated.
 *
 *   npm run dev
 *   npm run verify:constraints
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

await page.evaluate(() => {
  window.__volume = (mesh) => {
    const p = mesh.positions;
    const ix = mesh.indices;
    let total = 0;
    for (let i = 0; i < ix.length; i += 3) {
      const a = ix[i] * 3;
      const b = ix[i + 1] * 3;
      const c = ix[i + 2] * 3;
      total +=
        p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return Math.abs(total) / 6;
  };
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
    throw new Error(`solve did not settle (pending=${window.wirecad.pending()})`);
  };
});

const out = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });

  // Four sloppy corners, told to be a rectangle of a given width and height.
  const points = [0.4, -0.3, 52, 1.7, 49, 31, -1.2, 28];
  const entities = [
    ['line', 0, 1],
    ['line', 1, 2],
    ['line', 2, 3],
    ['line', 3, 0],
  ];
  const constraints = [
    ['lockU', 0, 'originU'],
    ['lockV', 0, 'originV'],
    ['horizontal', 0],
    ['horizontal', 2],
    ['vertical', 1],
    ['vertical', 3],
    ['horizontalDistance', 0, 1, 'width'],
    ['verticalDistance', 0, 3, 'height'],
  ];
  const dims = ['originU', 0, 'originV', 0, 'width', 50, 'height', 30];

  graph.addNode('sketch.constrained', {
    id: 'sk',
    label: 'Plate',
    inputs: { points, entities, constraints, dims },
  });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 10 } });
  graph.connect({ node: 'sk', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();

  const labels = graph
    .schemaOf('sk')
    .inputs.filter((p) => p.hidden !== true)
    .map((p) => p.label);

  const read = (id) => {
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === id);
    return {
      error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
    };
  };

  const asDrawn = read('body');

  graph.setInput('sk', 'd_width', 120);
  await window.__settle();
  const widened = read('body');

  // A dimension driven by a wire, like any other.
  graph.addNode('math.number', { id: 'p', label: 'Plate height', inputs: { value: 45 } });
  graph.connect({ node: 'p', port: 'result' }, { node: 'sk', port: 'd_height' });
  await window.__settle();
  const wired = read('body');

  // Now ask for something impossible: a diagonal that cannot hold.
  graph.setInput('sk', 'constraints', [...constraints, ['distance', 0, 2, 'width']]);
  await window.__settle();
  const impossible = window.wirecad.reports().find((r) => r.nodeId === 'sk')?.error ?? null;

  return { labels, asDrawn, widened, wired, impossible };
});

const near = (got, want) => got !== null && Math.abs(got - want) < 0.5;
const checks = [
  ['dimensions become ports    ', out.labels.join(',') === 'Plane,originU,originV,width,height', out.labels.join(',')],
  ['solves to 50 x 30 x 10     ', near(out.asDrawn.volume, 50 * 30 * 10), detail(out.asDrawn)],
  ['follows width to 120       ', near(out.widened.volume, 120 * 30 * 10), detail(out.widened)],
  ['height driven by a wire    ', near(out.wired.volume, 120 * 45 * 10), detail(out.wired)],
  ['impossible set is refused  ', out.impossible !== null, out.impossible ?? 'solved anyway'],
];

function detail(entry) {
  return entry.error ?? `${entry.volume?.toFixed(0)} mm3`;
}

let failures = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
}

// Now the same thing the way a person gets there: draw a rectangle in sketch
// mode and check it comes out constrained and dimensioned.
console.log('');
console.log('drawing one:');

await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  // Sketch mode needs the plane's value, which only a solve produces.
  await window.__settle();
});
await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Create Sketch', exact: true }).click();
await page.locator('.feature-dialog select').first().selectOption({ label: 'XY Plane' });
await page.getByRole('button', { name: 'Create', exact: true }).click();
const panel = page.locator('.sketch-panel:not(.sketch-editor)');
await panel.getByRole('button', { name: 'Rectangle', exact: true }).click();

const canvas = await page.locator('canvas').first().boundingBox();
await page.mouse.click(canvas.x + canvas.width * 0.42, canvas.y + canvas.height * 0.42);
await page.mouse.click(canvas.x + canvas.width * 0.58, canvas.y + canvas.height * 0.56);
// A rectangle completes on its second corner, so sketch mode has already left.
await page.locator('.sketch-panel:not(.sketch-editor)').waitFor({ state: 'hidden', timeout: 10_000 });

const drawn = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const node = graph.allNodes().find((n) => n.type === 'sketch.constrained');
  if (node === undefined) return { found: false };
  const schema = graph.schemaOf(node.id);
  return {
    found: true,
    labels: schema.inputs.filter((p) => p.hidden !== true).map((p) => p.label),
    error: window.wirecad.reports().find((r) => r.nodeId === node.id)?.error ?? null,
    relations: (graph.inputValue(node.id, 'constraints') ?? []).map((row) => row[0]),
  };
});

const drawChecks = [
  ['drawing makes a Sketch node', drawn.found, String(drawn.found)],
  ['it solves                  ', drawn.error === null, drawn.error ?? 'clean'],
  ['with width and height      ', (drawn.labels ?? []).includes('width') && drawn.labels.includes('height'),
    (drawn.labels ?? []).join(',')],
  ['and the relations drawn    ', (drawn.relations ?? []).filter((k) => k === 'horizontal').length === 2 &&
    (drawn.relations ?? []).filter((k) => k === 'vertical').length === 2,
    (drawn.relations ?? []).join(',')],
];
for (const [name, ok, extra] of drawChecks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
}

// The interactive editor: select geometry in the view, apply relations, and
// place a dimension.
console.log('');
console.log('editing one:');

const edit = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });

  // A wedge: a flat base and two loose corners, so there is freedom to remove.
  graph.addNode('sketch.constrained', {
    id: 'sk',
    inputs: {
      points: [0, 0, 40, 0, 25, 20],
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
  await window.__settle();
  return true;
});

await page.evaluate(() => window.wirecad.select('sk'));
await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Edit Sketch', exact: true }).click();

const editor = page.locator('.sketch-editor');
await editor.waitFor({ state: 'visible', timeout: 10_000 });
const startStatus = await editor.locator('.sketch-status').innerText();

// Click the two sloping edges, then make them equal.
// Click the midpoint of an edge, read from wherever the solver has it now.
const pickEdge = async (a, b) => {
  const info = await page.evaluate(
    ([a, b]) => {
      const points = window.wirecad.sketchEditor.solvedPoints();
      const from = points[a];
      const to = points[b];
      const uv = { u: (from.u + to.u) / 2, v: (from.v + to.v) / 2 };
      return { at: window.wirecad.screenOfSketch(uv.u, uv.v) };
    },
    [a, b],
  );
  await page.mouse.click(info.at.x, info.at.y);
};

await pickEdge(1, 2);
await pickEdge(2, 0);
await editor.getByRole('button', { name: 'Equal', exact: true }).click();
const afterEqual = await editor.locator('.sketch-status').innerText();

await pickEdge(0, 1);
await editor.getByRole('button', { name: 'Dimension', exact: true }).click();
const afterDimension = await editor.locator('.sketch-status').innerText();

// One slope length is all that is left between this and a determined sketch.
await pickEdge(1, 2);
await editor.getByRole('button', { name: 'Dimension', exact: true }).click();
const afterSecond = await editor.locator('.sketch-status').innerText();

const state = await page.evaluate(() => {
  const { graph } = window.wirecad;
  const kinds = (graph.inputValue('sk', 'constraints') ?? []).map((row) => row[0]);
  const labels = graph
    .schemaOf('sk')
    .inputs.filter((p) => p.hidden !== true)
    .map((p) => p.label);
  return { kinds, labels, rows: document.querySelectorAll('.sketch-row').length };
});

await editor.getByRole('button', { name: 'Done', exact: true }).click();

// Six unknowns, less a locked point and a horizontal base, is three.
const editChecks = [
  ['opens under-constrained    ', /3 degrees of freedom/.test(startStatus), startStatus],
  ['Equal takes one away       ', /2 degrees of freedom/.test(afterEqual), afterEqual],
  ['a dimension takes another  ', /1 degree of freedom/.test(afterDimension), afterDimension],
  ['the last one determines it ', /Fully constrained/.test(afterSecond), afterSecond],
  ['the relation is stored     ', state.kinds.includes('equal'), state.kinds.join(',')],
  ['dimensions become ports    ', state.labels.filter((l) => /^length/.test(l)).length === 2,
    state.labels.join(',')],
  ['every rule is listed       ', state.rows === state.kinds.length, `${state.rows} rows, ${state.kinds.length} rules`],
];
for (const [name, ok, extra] of editChecks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
}

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
