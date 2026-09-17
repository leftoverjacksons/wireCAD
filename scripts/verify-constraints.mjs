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

// Now the same thing the way a person gets there: draw in a sketch session,
// with more than one thing in it, and leave when done rather than the session
// deciding for you.
console.log('');
console.log('drawing one:');

await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  // A sketch session needs the plane's value, which only a solve produces.
  await window.__settle();
});
// Where the camera is before a sketch takes it, to check it is handed back.
const cameraAt = () =>
  page.evaluate(() => {
    const { position } = window.wirecad.viewport.camera;
    return [position.x, position.y, position.z].map((n) => Math.round(n * 100) / 100);
  });
const cameraBefore = await cameraAt();

await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Create Sketch', exact: true }).click();
await page.locator('.feature-dialog select').first().selectOption({ label: 'XY Plane' });
await page.getByRole('button', { name: 'Create', exact: true }).click();

const panel = page.locator('.sketch-panel');
await panel.waitFor({ state: 'visible', timeout: 10_000 });

const canvas = await page.locator('canvas').first().boundingBox();
const at = (fx, fy) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy];

// A rectangle...
await panel.getByRole('button', { name: 'Rectangle', exact: true }).click();
await page.mouse.click(...at(0.36, 0.34));
await page.mouse.click(...at(0.64, 0.62));
const afterRectangle = await panel.isVisible();

// ...and a circle inside it, in the same session.
await panel.getByRole('button', { name: 'Circle', exact: true }).click();
await page.mouse.click(...at(0.5, 0.48));
await page.mouse.click(...at(0.54, 0.48));

const drawn = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const node = graph.allNodes().find((n) => n.type === 'sketch.constrained');
  if (node === undefined) return { found: false };

  const points = graph.inputValue(node.id, 'points') ?? [];
  const entities = graph.inputValue(node.id, 'entities') ?? [];
  const uv = [];
  for (let i = 0; i < points.length; i += 2) uv.push({ u: points[i], v: points[i + 1] });
  const circle = entities.find((row) => row[0] === 'circle');

  return {
    found: true,
    id: node.id,
    status: document.querySelector('.sketch-status')?.textContent ?? '',
    labels: graph.schemaOf(node.id).inputs.filter((p) => p.hidden !== true).map((p) => p.label),
    error: window.wirecad.reports().find((r) => r.nodeId === node.id)?.error ?? null,
    relations: (graph.inputValue(node.id, 'constraints') ?? []).map((row) => row[0]),
    kinds: entities.map((row) => row[0]),
    // The rectangle is the four points its edges run through.
    width: Math.max(...uv.slice(0, 4).map((p) => p.u)) - Math.min(...uv.slice(0, 4).map((p) => p.u)),
    height: Math.max(...uv.slice(0, 4).map((p) => p.v)) - Math.min(...uv.slice(0, 4).map((p) => p.v)),
    radius: circle === undefined ? 0 : circle[2],
  };
});

// Finish is the only thing that ends a session.
await panel.getByRole('button', { name: 'Finish', exact: true }).click();
await panel.waitFor({ state: 'hidden', timeout: 10_000 });
const cameraAfter = await cameraAt();

const extruded = await page.evaluate(async (sketchId) => {
  const { graph } = window.wirecad;
  graph.addNode('solid.extrude', { id: 'drawnBody', inputs: { distance: 10 } });
  graph.connect({ node: sketchId, port: 'profile' }, { node: 'drawnBody', port: 'profile' });
  await window.__settle();

  const mesh = window.wirecad.meshes().find((m) => m.nodeId === 'drawnBody');
  return {
    error: window.wirecad.reports().find((r) => r.nodeId === 'drawnBody')?.error ?? null,
    volume: mesh === undefined ? null : window.__volume(mesh),
  };
}, drawn.id);

const wantVolume = (drawn.width * drawn.height - Math.PI * drawn.radius ** 2) * 10;
const drawChecks = [
  ['drawing makes a Sketch node', drawn.found, String(drawn.found)],
  ['it stays open after a shape', afterRectangle, afterRectangle ? 'still drawing' : 'it left'],
  ['a rectangle and a circle    ', drawn.kinds.join(',') === 'line,line,line,line,circle',
    drawn.kinds.join(',')],
  ['it solves                   ', drawn.error === null, drawn.error ?? 'clean'],
  ['with the relations drawn    ', (drawn.relations ?? []).filter((k) => k === 'horizontal').length === 2 &&
    (drawn.relations ?? []).filter((k) => k === 'vertical').length === 2,
    (drawn.relations ?? []).join(',')],
  ['and no lengths assumed      ', (drawn.labels ?? []).join(',') === 'Plane,originU,originV',
    (drawn.labels ?? []).join(',')],
  ['it says how loose it is     ', /degrees of freedom/.test(drawn.status), drawn.status],
  ['the view comes back         ', cameraAfter.join(',') === cameraBefore.join(','),
    `${cameraBefore.join(', ')} → ${cameraAfter.join(', ')}`],
  ['the circle becomes a hole   ', extruded.volume !== null && drawn.radius > 0 &&
    Math.abs(extruded.volume - wantVolume) / wantVolume < 0.01,
    extruded.error ?? `${extruded.volume?.toFixed(0)} mm3, wanted ${wantVolume.toFixed(0)}`],
];
for (const [name, ok, extra] of drawChecks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
}

// A sketch nobody drew in should not be left behind.
const abandoned = await (async () => {
  await page.evaluate(async () => {
    const { graph } = window.wirecad;
    graph.restore({ version: 1, nodes: [], edges: [] });
    graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
    await window.__settle();
  });
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Create Sketch', exact: true }).click();
  await page.locator('.feature-dialog select').first().selectOption({ label: 'XY Plane' });
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.locator('.sketch-panel').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('button', { name: 'Finish', exact: true }).click();
  await page.locator('.sketch-panel').waitFor({ state: 'hidden', timeout: 10_000 });
  return page.evaluate(() =>
    window.wirecad.graph.allNodes().filter((n) => n.type === 'sketch.constrained').length,
  );
})();

if (abandoned === 0) console.log('PASS  an empty one is not kept  → nothing left behind');
else {
  failures += 1;
  console.log(`FAIL  an empty one is not kept  → ${abandoned} left behind`);
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

const editor = page.locator('.sketch-panel');
await editor.waitFor({ state: 'visible', timeout: 10_000 });
const startStatus = await editor.locator('.sketch-status').innerText();

// Click the two sloping edges, then make them equal.
// Click the midpoint of an edge, read from wherever the solver has it now.
const pickEdge = async (a, b) => {
  const info = await page.evaluate(
    ([a, b]) => {
      const points = window.wirecad.sketch.solvedPoints();
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

await editor.getByRole('button', { name: 'Finish', exact: true }).click();

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
