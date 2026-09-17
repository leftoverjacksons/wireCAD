/**
 * Checks per-edge fillet selection against the real kernel: that picking a
 * subset of edges rounds only those, and that the stored reference still finds
 * the same edges after the body is resized underneath it.
 *
 *   npm run dev
 *   npm run verify:edges
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

await page.addInitScript(() => {});
await page.evaluate(() => {
  // Volume of a closed triangulation, by the divergence theorem.
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
  // A solve already in flight finishes first and reports the previous document,
  // so waiting for one tick can read stale results. Wait for the solver to go
  // quiet instead.
  window.__settle = async () => {
    const before = window.wirecad.solves();
    window.wirecad.solve();
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (window.wirecad.solves() <= before) continue;
      const settled = window.wirecad.solves();
      await new Promise((r) => setTimeout(r, 300));
      if (window.wirecad.solves() === settled) return;
    }
    throw new Error('solve did not settle');
  };
});

const result = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const log = [];

  graph.restore({ version: 1, nodes: [], edges: [] });
  const rect = graph.addNode('sketch.rectangle', { id: 'rect', inputs: { width: 60, height: 40 } });
  const extrude = graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
  graph.connect({ node: rect.id, port: 'profile' }, { node: extrude.id, port: 'profile' });
  await window.__settle();

  const all = window.wirecad.viewport.edgesOf('body') ?? [];
  log.push(`extruded box exposes ${all.length} edges`);

  const vertical = [];
  for (const [index, edge] of all.entries()) {
    if (Math.abs(edge.direction.z) > 0.9) vertical.push({ index, edge });
  }
  log.push(`${vertical.length} of them run vertically`);

  const refs = [];
  for (const { edge } of vertical) {
    refs.push(
      edge.fraction.x, edge.fraction.y, edge.fraction.z,
      edge.direction.x, edge.direction.y, edge.direction.z,
      edge.length,
    );
  }

  const selection = graph.addNode('edge.selection', { id: 'sel', inputs: { refs } });
  const fillet = graph.addNode('solid.fillet', { id: 'fil', inputs: { radius: 3 } });
  graph.connect({ node: 'body', port: 'solid' }, { node: 'fil', port: 'solid' });
  graph.connect({ node: selection.id, port: 'edges' }, { node: 'fil', port: 'edges' });
  await window.__settle();

  const read = () => {
    const report = window.wirecad.reports().find((r) => r.nodeId === 'fil');
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === 'fil');
    return {
      error: report?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
    };
  };

  const selective = read();
  log.push(`4 vertical edges at r=3: ${selective.error ?? `${selective.volume.toFixed(0)} mm3`}`);

  // Resize the body. The reference is stored as a fraction of the bounding box,
  // so it should still land on the same four edges.
  graph.setInput('rect', 'width', 80);
  await window.__settle();
  const resized = read();
  log.push(`after widening 60 -> 80: ${resized.error ?? `${resized.volume.toFixed(0)} mm3`}`);

  // And a much taller body, which moves every midpoint in Z.
  graph.setInput('body', 'distance', 50);
  await window.__settle();
  const taller = read();
  log.push(`after extruding 20 -> 50: ${taller.error ?? `${taller.volume.toFixed(0)} mm3`}`);

  return { log, selective, resized, taller };
});

for (const line of result.log) console.log(' ', line);

// A cylinder of radius r replaced by a quarter-round at each of 4 corners removes
// (1 - pi/4) * r^2 * height of material, and nothing else should change.
const trim = (r, h) => (1 - Math.PI / 4) * r * r * h * 4;
const expected = [
  ['4 vertical edges ', result.selective, 60 * 40 * 20 - trim(3, 20)],
  ['after widening   ', result.resized, 80 * 40 * 20 - trim(3, 20)],
  ['after extruding  ', result.taller, 80 * 40 * 50 - trim(3, 50)],
];

let failures = 0;
for (const [name, got, want] of expected) {
  const ok = got.error === null && got.volume !== null && Math.abs(got.volume - want) < want * 0.002;
  if (!ok) failures += 1;
  const detail = got.error ?? `${got.volume?.toFixed(0)} mm3, expected ${want.toFixed(0)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
}

// The same thing again, but driven the way a person drives it: open the Fillet
// dialog from the toolbar and click an edge in the 3D view.
console.log('');
console.log('through the toolbar and the viewport:');

await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('sketch.rectangle', { id: 'rect', inputs: { width: 60, height: 40 } });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
  graph.connect({ node: 'rect', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();
});

await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.getByRole('button', { name: 'Fillet', exact: true }).click();

const dialogText = await page.locator('.feature-dialog').innerText();
const armsEdges = dialogText.includes('Edges') && dialogText.includes('none picked');
console.log(`${armsEdges ? 'PASS' : 'FAIL'}  Fillet dialog asks for edges → ${JSON.stringify(dialogText.split('\n').slice(0, 3))}`);
if (!armsEdges) process.exitCode = 1;

const target = await page.evaluate(() => {
  const edges = window.wirecad.viewport.edgesOf('body') ?? [];
  const vertical = edges.find((e) => Math.abs(e.direction.z) > 0.9);
  return vertical === undefined ? null : window.wirecad.viewport.screenPositionOf(vertical.midpoint);
});

if (target === null) {
  console.log('FAIL  no vertical edge to click');
  process.exitCode = 1;
} else {
  await page.mouse.click(target.x, target.y);
  const afterClick = await page.locator('.feature-dialog').innerText();
  const picked = /1 edge of/.test(afterClick);
  console.log(`${picked ? 'PASS' : 'FAIL'}  clicking an edge selects it → ${afterClick.split('\n')[1] ?? ''}`);
  if (!picked) process.exitCode = 1;

  await page.getByRole('button', { name: 'Create' }).click();
  const built = await page.evaluate(async () => {
    await window.__settle();
    const types = window.wirecad.graph.allNodes().map((n) => n.type);
    const report = window.wirecad.reports().find((r) => r.nodeId !== null && window.wirecad.graph.getNode(r.nodeId)?.type === 'solid.fillet');
    return { types, error: report?.error ?? null };
  });
  const madeNodes =
    built.types.includes('edge.selection') && built.types.includes('solid.fillet') && built.error === null;
  console.log(`${madeNodes ? 'PASS' : 'FAIL'}  Create builds the nodes → ${built.error ?? built.types.join(', ')}`);
  if (!madeNodes) process.exitCode = 1;
}

// The profile that drove an extrude used to stay on screen, so its outline sat
// on top of the body's lower edges and swallowed clicks meant for them.
console.log('');
console.log('profile visibility:');

const vis = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('sketch.rectangle', { id: 'rect', inputs: { width: 60, height: 40 } });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 20 } });
  graph.connect({ node: 'rect', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();
  const hiddenByDefault = !window.wirecad.visible().includes('rect');

  graph.setVisibility('rect', true);
  await window.__settle();
  const shownWhenPinned = window.wirecad.visible().includes('rect');

  graph.setVisibility('rect', false);
  await window.__settle();
  const hiddenWhenPinned = !window.wirecad.visible().includes('rect');

  graph.setVisibility('rect', undefined);
  await window.__settle();
  return { hiddenByDefault, shownWhenPinned, hiddenWhenPinned };
});

for (const [name, ok] of [
  ['an extruded profile hides itself     ', vis.hiddenByDefault],
  ['the eye can force it back on         ', vis.shownWhenPinned],
  ['and can force a body off             ', vis.hiddenWhenPinned],
]) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

await page.getByRole('button', { name: 'Fillet', exact: true }).click();
const lower = await page.evaluate(() => {
  const edges = window.wirecad.viewport.edgesOf('body') ?? [];
  // A bottom edge: horizontal, and sitting at the base of the bounding box.
  const found = edges.find((e) => Math.abs(e.direction.z) < 0.1 && e.fraction.z < 0.01);
  return found === undefined ? null : window.wirecad.viewport.screenPositionOf(found.midpoint);
});

if (lower === null) {
  console.log('FAIL  no lower edge found to click');
  process.exitCode = 1;
} else {
  await page.mouse.click(lower.x, lower.y);
  const text = await page.locator('.feature-dialog').innerText();
  const ok = /1 edge of/.test(text) && !/not on a solid/.test(text);
  console.log(`${ok ? 'PASS' : 'FAIL'}  a lower edge selects → ${text.split('\n').slice(1, 3).join(' | ')}`);
  if (!ok) process.exitCode = 1;
}
await page.getByRole('button', { name: 'Cancel' }).click();

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
