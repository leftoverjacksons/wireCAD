/**
 * Checks that a drawn profile is one node carrying its own named dimensions:
 * that the dimensions appear, that editing one moves that corner and nothing
 * else, and that a parameter node can drive one through a wire.
 *
 *   npm run dev
 *   npm run verify:profile
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
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (window.wirecad.solves() <= before) continue;
      const seen = window.wirecad.solves();
      await new Promise((r) => setTimeout(r, 300));
      if (window.wirecad.solves() === seen) return;
    }
    throw new Error(
      `solve did not settle (before=${before}, now=${window.wirecad.solves()}, pending=${window.wirecad.pending()})`,
    );
  };
});

let result;
try {
  result = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });

  // A 60 x 40 rectangle, drawn as a free polygon.
  graph.addNode('sketch.polygon', {
    id: 'prof',
    inputs: { points: [0, 0, 60, 0, 60, 40, 0, 40] },
  });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
  graph.connect({ node: 'prof', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();

  const volume = () => {
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === 'body');
    return mesh === undefined ? null : window.__volume(mesh);
  };
  const error = () => window.wirecad.reports().find((r) => r.nodeId === 'prof')?.error ?? null;

  const rows = [...document.querySelectorAll('.node[data-node-id="prof"] .node-row')].length;
  const labels = [...document.querySelectorAll('.node[data-node-id="prof"] .port-label')].map(
    (el) => el.textContent,
  );
  const badge =
    document.querySelector('.node[data-node-id="prof"] .node-kind')?.textContent ?? null;

  const asDrawn = { error: error(), volume: volume() };

  // Pull one corner out. The profile becomes a trapezoid; nothing else moves.
  graph.setInput('prof', 'p2u', 80);
  await window.__settle();
  const moved = { error: error(), volume: volume() };

  // Drive the same corner from a parameter instead.
  graph.setInput('prof', 'p2u', 60);
  const param = graph.addNode('math.number', { id: 'p', label: 'Front', inputs: { value: 100 } });
  graph.connect({ node: param.id, port: 'result' }, { node: 'prof', port: 'p2u' });
  await window.__settle();
  const wired = { error: error(), volume: volume() };

    return { rows, labels, badge, asDrawn, moved, wired };
  });
} catch (thrown) {
  console.log('solver never returned:', String(thrown).split('\n')[0]);
  console.log('status bar says     :', await page.locator('#kernel-status').innerText());
  await browser.close();
  process.exit(1);
}

console.log(' ', `profile node badge: ${result.badge}`);
console.log(' ', `port rows: ${result.rows}`);
console.log(' ', `labels: ${JSON.stringify(result.labels)}`);

// Trapezoid area is the mean of the parallel sides times the span.
const checks = [
  ['dimensions appear, named  ', result.labels.join(',').includes('P2 U'), ''],
  ['one node, not a tree      ', result.badge === 'Profile', String(result.badge)],
  ['as drawn                  ', near(result.asDrawn.volume, 60 * 40 * 20), detail(result.asDrawn)],
  ['one corner pulled to 80   ', near(result.moved.volume, ((80 + 60) / 2) * 40 * 20), detail(result.moved)],
  ['same corner driven by wire', near(result.wired.volume, ((100 + 60) / 2) * 40 * 20), detail(result.wired)],
];

function near(got, want) {
  return got !== null && Math.abs(got - want) < Math.max(want * 0.001, 0.5);
}
function detail(entry) {
  return entry.error ?? `${entry.volume?.toFixed(0)} mm3`;
}

let failures = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
}

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
