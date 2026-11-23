/**
 * Checks that an extrude defaults its operation and target from what it would
 * meet: a cut into a body it runs into, a join onto a body it stands on, a new
 * body when it meets nothing — and that whatever is set by hand stays set.
 *
 *   npm run dev
 *   npm run verify:operation
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
const near = (a, b, slack) => Math.abs(a - b) <= slack;

await page.evaluate(() => {
  /** Waits until solving has stopped, including solves one answer sets off. */
  window.__settle = async () => {
    window.wirecad.solve();
    let seen = -1;
    let quiet = 0;
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const now = window.wirecad.solves();
      if (now === seen && !window.wirecad.pending()) quiet += 1;
      else quiet = 0;
      seen = now;
      if (quiet >= 6) return;
    }
    throw new Error('solve did not settle');
  };
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
});

// The starter block — 60 by 40 by 20, bored through — with a circle of radius
// 4 on its front face, the one facing -Y. The face's U runs along X and its V
// up Z, from the middle of the face, so the circle sits clear of the bore.
const boreId = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  const bore = graph.allNodes().find((node) => node.label === 'Bore');
  graph.addNode('face.plane', { id: 'front', inputs: { nx: 0, ny: -1, nz: 0, rank: 0 } });
  graph.connect({ node: bore.id, port: 'solid' }, { node: 'front', port: 'solid' });
  graph.addNode('sketch.circle', { id: 'dot', label: 'Dot', inputs: { radius: 4, u: 0, v: 0 } });
  graph.connect({ node: 'front', port: 'plane' }, { node: 'dot', port: 'plane' });
  // And one far off on the ground plane, near nothing at all.
  graph.addNode('sketch.circle', { id: 'far', label: 'Far', inputs: { radius: 4, u: 200, v: 0 } });
  await window.__settle();
  return bore.id;
});

const dialog = page.locator('.feature-dialog');

/** The dialog's operation, target, their labels, and what it says. */
const state = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll('.feature-dialog .feature-row')];
    const row = (prefix) =>
      rows.find((entry) => entry.querySelector('.feature-label')?.textContent?.startsWith(prefix));
    const operation = row('Operation');
    const target = row('Target');
    return {
      operation: operation?.querySelector('select')?.value ?? null,
      operationLabel: operation?.querySelector('.feature-label')?.textContent ?? null,
      target: target?.querySelector('select')?.value ?? null,
      targetLabel: target?.querySelector('.feature-label')?.textContent ?? null,
      message: document.querySelector('.feature-dialog .feature-message')?.textContent ?? '',
    };
  });

async function setDistance(value) {
  const field = dialog.locator('input.feature-number').first();
  await field.fill(String(value));
  await page.evaluate(() => window.__settle());
}

async function openExtrude(profile) {
  await page.evaluate((id) => window.wirecad.select(id), profile);
  await page.getByRole('button', { name: 'Solid', exact: true }).click();
  await page.getByRole('button', { name: 'Extrude', exact: true }).click();
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => window.__settle());
}

/** The preview's own body, as the worker last meshed it. */
const previewVolume = () =>
  page.evaluate(() => {
    const id = window.wirecad.dialog.previewNodeId;
    const mesh = window.wirecad.meshes().find((entry) => entry.nodeId === id);
    return mesh === undefined ? null : window.__volume(mesh);
  });

// Measured from the block's own mesh rather than worked out, because the bore
// is meshed as a polygon and removes slightly less than a true cylinder would.
const block = await page.evaluate((id) => {
  const mesh = window.wirecad.meshes().find((entry) => entry.nodeId === id);
  return window.__volume(mesh);
}, boreId);
const plug = Math.PI * 4 * 4 * 10;

console.log('a sketch on the face of a body:');

await openExtrude('dot');
let now = await state();
check('extruding away from the face joins the body it stands on', now.operation === 'Join', JSON.stringify(now));
check('with that body as the target', now.target === boreId, String(now.target));
check('both marked as chosen for you', now.operationLabel.includes('auto') && now.targetLabel.includes('auto'));
check('and the dialog says why', now.message.includes('stands on'), now.message);
let volume = await previewVolume();
check('the preview is the block with a boss on it', volume !== null && near(volume, block + plug, 4), `${volume?.toFixed(1)} mm³`);
if (shots) await page.screenshot({ path: `${shots}/operation-1-join.png` });

await setDistance(-10);
now = await state();
check('extruding into the body cuts it', now.operation === 'Cut', JSON.stringify(now));
check('still targeting the body it runs into', now.target === boreId, String(now.target));
check('and says so', now.message.includes('runs into'), now.message);
volume = await previewVolume();
check('the preview is the block with a pocket in it', volume !== null && near(volume, block - plug, 4), `${volume?.toFixed(1)} mm³`);
if (shots) await page.screenshot({ path: `${shots}/operation-2-cut.png` });

// Set by hand, the operation stays put whatever the distance does.
await dialog
  .locator('.feature-row')
  .filter({ hasText: 'Operation' })
  .locator('select')
  .selectOption('New body');
await page.evaluate(() => window.__settle());
await setDistance(-12);
now = await state();
check('an operation set by hand is kept as the distance changes', now.operation === 'New body', JSON.stringify(now));
check('and is no longer marked as chosen for you', !now.operationLabel.includes('auto'), now.operationLabel);
check('a new body chosen by hand has no target', now.target === '', String(now.target));

await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
await page.evaluate(() => window.__settle());

// Open again and keep the cut it chooses for itself.
await openExtrude('dot');
await setDistance(-10);
await dialog.getByRole('button', { name: 'Create', exact: true }).click();
await page.evaluate(() => window.__settle());
const built = await page.evaluate(() => {
  const { graph } = window.wirecad;
  const extrude = graph
    .allNodes()
    .find((node) => node.type === 'solid.extrude' && graph.incomingEdge(node.id, 'profile')?.from.node === 'dot');
  return {
    operation: extrude?.inputs.operation ?? null,
    target: extrude === undefined ? null : (graph.incomingEdge(extrude.id, 'target')?.from.node ?? null),
    error: window.wirecad.reports().find((entry) => entry.nodeId === extrude?.id)?.error ?? null,
  };
});
check('Create keeps the cut it chose', built.operation === 'Cut', JSON.stringify(built));
check('wired to the body it cuts', built.target === boreId, String(built.target));
check('and it builds', built.error === null, String(built.error));

console.log('a sketch that meets nothing:');

await openExtrude('far');
now = await state();
check('stays a new body', now.operation === 'New body', JSON.stringify(now));
check('with no target', now.target === '', String(now.target));
check('and nothing said about it', now.message === '', now.message);
await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

check('nothing threw on the page', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
