/**
 * Checks that a feature dialog shows what it is about to make, before it makes
 * it: the preview is in the model while the dialog is open, follows its
 * numbers, follows the handle dragged in the view, survives Create, and leaves
 * nothing behind on Cancel.
 *
 *   npm run dev
 *   npm run verify:preview
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
  // What the model currently holds for the feature being previewed.
  window.__body = async (type) => {
    await window.__settle();
    const { graph } = window.wirecad;
    const node = graph.allNodes().find((candidate) => candidate.type === type);
    if (node === undefined) return { present: false };
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === node.id);
    return {
      present: true,
      id: node.id,
      error: window.wirecad.reports().find((r) => r.nodeId === node.id)?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
      shown: window.wirecad.visible().includes(node.id),
    };
  };
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};

// A profile on its own, with nothing built from it yet.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  graph.addNode('sketch.rectangle', {
    id: 'plate',
    label: 'Plate',
    inputs: { width: 60, height: 40 },
  });
  graph.connect({ node: 'xy', port: 'plane' }, { node: 'plate', port: 'plane' });
  await window.__settle();
  window.wirecad.select('plate');
});

const undoBefore = await page.evaluate(() => window.wirecad.history.canUndo);

await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.getByRole('button', { name: 'Extrude', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible', timeout: 10_000 });

// Nothing has been pressed but Extrude: the body should already be there.
const previewed = await page.evaluate(() => window.__body('solid.extrude'));
check('a body before Create    ', previewed.present && Math.abs(previewed.volume - 24000) < 1,
  previewed.error ?? `${previewed.volume?.toFixed(0)} mm3`);

// Typing a distance moves it, still without pressing Create.
await page.locator('.feature-dialog input[type=number]').first().fill('25');
const retyped = await page.evaluate(() => window.__body('solid.extrude'));
check('it follows the number   ', retyped.present && Math.abs(retyped.volume - 60000) < 1,
  retyped.error ?? `${retyped.volume?.toFixed(0)} mm3`);

// The arrow on the model sets the same number.
const handle = await page.evaluate(() => window.wirecad.handleAt());
check('an arrow to drag        ', handle !== null, handle === null ? 'no handle' : `at ${Math.round(handle.x)}, ${Math.round(handle.y)}`);

let dragged = { present: false };
let draggedDistance = null;
if (handle !== null) {
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y - 60, { steps: 12 });
  await page.mouse.up();
  draggedDistance = await page.evaluate(() =>
    Number(document.querySelector('.feature-dialog input[type=number]').value),
  );
  dragged = await page.evaluate(() => window.__body('solid.extrude'));
}
check('dragging sets the number', draggedDistance !== null && draggedDistance > 25,
  `${draggedDistance} mm`);
check('and the body follows it ', dragged.present && draggedDistance !== null &&
  Math.abs(dragged.volume - 60 * 40 * draggedDistance) / (60 * 40 * draggedDistance) < 0.001,
  dragged.error ?? `${dragged.volume?.toFixed(0)} mm3`);

// Cancel takes it back out, and leaves no undo step behind.
await page.locator('.feature-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
const cancelled = await page.evaluate(async () => {
  await window.__settle();
  return {
    body: await window.__body('solid.extrude'),
    canUndo: window.wirecad.history.canUndo,
    nodes: window.wirecad.graph.allNodes().length,
  };
});
check('Cancel takes it back out', !cancelled.body.present, cancelled.body.present ? 'still there' : 'gone');
check('and leaves no undo step ', cancelled.canUndo === undoBefore && cancelled.nodes === 2,
  `canUndo ${cancelled.canUndo}, ${cancelled.nodes} nodes`);

// Create keeps exactly what was on screen, and one undo removes it.
await page.getByRole('button', { name: 'Extrude', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible' });
await page.locator('.feature-dialog input[type=number]').first().fill('12');
const beforeCreate = await page.evaluate(() => window.__body('solid.extrude'));
await page.locator('.feature-dialog').getByRole('button', { name: 'Create', exact: true }).click();
const afterCreate = await page.evaluate(() => window.__body('solid.extrude'));
check('Create keeps that body  ',
  beforeCreate.present && afterCreate.present &&
  Math.abs(afterCreate.volume - beforeCreate.volume) < 1e-6 &&
  Math.abs(afterCreate.volume - 28800) < 1,
  `${beforeCreate.volume?.toFixed(0)} → ${afterCreate.volume?.toFixed(0)} mm3`);

const undone = await page.evaluate(async () => {
  window.wirecad.history.undo();
  return window.__body('solid.extrude');
});
check('one undo removes it     ', !undone.present, undone.present ? 'still there' : 'gone');

// A fillet previews as the edges are picked.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  await window.__settle();
});
const plain = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const bore = graph.allNodes().find((n) => n.label === 'Bore');
  const mesh = window.wirecad.meshes().find((m) => m.nodeId === bore?.id);
  return { volume: mesh === undefined ? null : window.__volume(mesh) };
});

await page.getByRole('button', { name: 'Fillet', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible' });

// Click a vertical edge of the block, chosen from the mesh the worker sent.
const edgeAt = await page.evaluate(() => {
  const body = window.wirecad.graph.allNodes().find((n) => n.label === 'Bore');
  const mesh = window.wirecad.meshes().find((m) => m.nodeId === body?.id);
  if (mesh === undefined) return null;
  const edge = mesh.edges
    .map((e, index) => ({ ...e, index }))
    .filter((e) => Math.abs(e.direction.z) > 0.9)
    .sort((a, b) => b.length - a.length)[0];
  return edge === undefined ? null : window.wirecad.viewport.screenPositionOf(edge.midpoint);
});
if (edgeAt !== null) await page.mouse.click(edgeAt.x, edgeAt.y);

const filleted = await page.evaluate(() => window.__body('solid.fillet'));
check('a fillet as edges are picked',
  filleted.present && filleted.error === null && filleted.volume !== null &&
  filleted.volume < plain.volume,
  filleted.error ?? `${filleted.volume?.toFixed(0)} mm3 against ${plain.volume?.toFixed(0)}`);

await page.locator('.feature-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
const afterFillet = await page.evaluate(async () => {
  await window.__settle();
  return window.__body('solid.fillet');
});
check('and Cancel undoes it    ', !afterFillet.present, afterFillet.present ? 'still there' : 'gone');

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
