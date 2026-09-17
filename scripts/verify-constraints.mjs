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

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
