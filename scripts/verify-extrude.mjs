/**
 * Checks that an extrude can combine with the body it meets, so a bore is the
 * same node as the body that holds it rather than a boolean node downstream.
 *
 *   npm run dev
 *   npm run verify:extrude
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
  const read = (id) => {
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === id);
    return {
      error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
    };
  };

  const build = async (operation) => {
    graph.restore({ version: 1, nodes: [], edges: [] });
    graph.addNode('sketch.rectangle', { id: 'rect', inputs: { width: 60, height: 40 } });
    graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
    graph.connect({ node: 'rect', port: 'profile' }, { node: 'body', port: 'profile' });

    graph.addNode('sketch.circle', { id: 'circ', inputs: { radius: 8, u: 30, v: 20 } });
    graph.addNode('solid.extrude', { id: 'tool', inputs: { distance: 20, operation } });
    graph.connect({ node: 'circ', port: 'profile' }, { node: 'tool', port: 'profile' });
    graph.connect({ node: 'body', port: 'solid' }, { node: 'tool', port: 'target' });
    await window.__settle();
    return read('tool');
  };

  const cut = await build('Cut');
  const intersect = await build('Intersect');

  // No target wired, but an operation that needs one.
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('sketch.rectangle', { id: 'rect', inputs: { width: 60, height: 40 } });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20, operation: 'Cut' } });
  graph.connect({ node: 'rect', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();
  const orphan = read('body');

  // And the model a fresh install opens with.
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  await window.__settle();
  const starter = {
    nodes: graph.nodeCount,
    types: graph.allNodes().map((n) => n.type),
    errors: window.wirecad.reports().filter((r) => r.error !== undefined).length,
  };

  return { cut, intersect, orphan, starter };
});

const bore = Math.PI * 8 * 8 * 20;
const checks = [
  ['Cut bores the body       ', near(out.cut.volume, 60 * 40 * 20 - bore), detail(out.cut)],
  ['Intersect keeps the plug ', near(out.intersect.volume, bore), detail(out.intersect)],
  ['Cut with no target says so', out.orphan.error !== null, out.orphan.error ?? 'no error'],
  ['starter is four nodes     ', out.starter.nodes === 5, `${out.starter.nodes}: ${out.starter.types.join(', ')}`],
  ['starter solves clean      ', out.starter.errors === 0, `${out.starter.errors} errored`],
];

function near(got, want) {
  return got !== null && Math.abs(got - want) < want * 0.01;
}
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
