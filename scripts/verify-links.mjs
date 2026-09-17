/**
 * Checks that a dimension a node holds can drive a dimension on another node,
 * and that nodes can be renamed in place.
 *
 *   npm run dev
 *   npm run verify:links
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

  const read = () => {
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === 'fil');
    return {
      error: window.wirecad.reports().find((r) => r.nodeId === 'fil')?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
    };
  };

  // Build a cylinder whose rim fillet is set by hand, as the control.
  const byHand = async (radius) => {
    graph.restore({ version: 1, nodes: [], edges: [] });
    graph.addNode('sketch.circle', { id: 'circ', inputs: { radius, u: 0, v: 0 } });
    graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
    graph.connect({ node: 'circ', port: 'profile' }, { node: 'body', port: 'profile' });
    graph.addNode('solid.fillet', { id: 'fil', inputs: { radius } });
    graph.connect({ node: 'body', port: 'solid' }, { node: 'fil', port: 'solid' });
    await window.__settle();
    return read();
  };

  // The same thing with the fillet radius taken from the circle's own Radius.
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('sketch.circle', { id: 'circ', inputs: { radius: 6, u: 0, v: 0 } });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
  graph.connect({ node: 'circ', port: 'profile' }, { node: 'body', port: 'profile' });
  const offersRadius = graph.outputPortOf('circ', 'radius') !== undefined;
  graph.addNode('solid.fillet', { id: 'fil', inputs: { radius: 2 } });
  graph.connect({ node: 'body', port: 'solid' }, { node: 'fil', port: 'solid' });
  const allowed = graph.canConnect(
    { node: 'circ', port: 'radius' },
    { node: 'fil', port: 'radius' },
  );
  graph.connect({ node: 'circ', port: 'radius' }, { node: 'fil', port: 'radius' });
  await window.__settle();
  const wiredAt6 = read();

  graph.setInput('circ', 'radius', 4);
  await window.__settle();
  const wiredAt4 = read();

  const handAt6 = await byHand(6);
  const handAt4 = await byHand(4);

  // Renaming, and clearing a name to get the type's own back.
  graph.setLabel('circ', 'Boss profile');
  const named = graph.requireNode('circ').label;
  const saved = graph.toJSON();
  graph.restore(saved);
  const survivedSave = graph.requireNode('circ').label;
  graph.setLabel('circ', '');
  const cleared = graph.requireNode('circ').label;

  return { offersRadius, allowed, wiredAt6, wiredAt4, handAt6, handAt4, named, survivedSave, cleared };
});

// A cylinder r=20 h=20 filleted 20 at both rims: each rim loses (1 - pi/4) r^2
// of section swept round, but checking it followed at all is the point here.
const same = (a, b) => a.error === null && b.error === null && Math.abs(a.volume - b.volume) < 0.5;

const checks = [
  ['a circle offers its Radius  ', out.offersRadius, String(out.offersRadius)],
  ['it may drive another radius ', out.allowed === null, out.allowed ?? 'allowed'],
  ['wired radius equals hand-set', same(out.wiredAt6, out.handAt6),
    `${out.wiredAt6.volume?.toFixed(1)} vs ${out.handAt6.volume?.toFixed(1)} mm3`],
  ['and follows when it changes ', same(out.wiredAt4, out.handAt4),
    `${out.wiredAt4.volume?.toFixed(1)} vs ${out.handAt4.volume?.toFixed(1)} mm3`],
  ['the two sizes really differ ', Math.abs(out.wiredAt6.volume - out.wiredAt4.volume) > 1,
    `${out.wiredAt6.volume?.toFixed(0)} vs ${out.wiredAt4.volume?.toFixed(0)} mm3`],
  ['nodes rename                ', out.named === 'Boss profile', String(out.named)],
  ['the name is saved           ', out.survivedSave === 'Boss profile', String(out.survivedSave)],
  ['clearing restores the default', out.cleared === undefined, String(out.cleared)],
];

let failures = 0;
for (const [name, ok, extra] of checks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
}

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
