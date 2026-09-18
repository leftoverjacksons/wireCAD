/**
 * Checks moving a body: appended at the end of a chain the whole thing shifts,
 * spliced into the middle the body moves and what was cut from it stays where
 * its sketch puts it. And that the gizmo is three arrows, one per axis.
 *
 *   npm run dev
 *   npm run verify:move
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
  window.__idOf = (label) => {
    const node = window.wirecad.graph.allNodes().find((n) => (n.label ?? n.type) === label);
    return node?.id ?? null;
  };
  /** What is on screen, measured: its volume and where it sits. */
  window.__model = async () => {
    // A selected node is drawn as a ghost of what it made, and a ghost is a
    // second solid as far as counting triangles goes. Nothing is selected while
    // a dialog is up, so this only matters afterwards.
    if (!window.wirecad.dialog.isOpen) window.wirecad.select(null);
    await window.__settle();
    let volume = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const mesh of window.wirecad.meshes()) {
      if (mesh.kind !== 'solid') continue;
      const p = mesh.positions;
      const ix = mesh.indices;
      let signed = 0;
      for (let i = 0; i < ix.length; i += 3) {
        const a = ix[i] * 3;
        const b = ix[i + 1] * 3;
        const c = ix[i + 2] * 3;
        signed +=
          p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
          p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
          p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
      }
      volume += Math.abs(signed) / 6;
      for (let i = 0; i < p.length; i += 3) {
        minX = Math.min(minX, p[i]);
        maxX = Math.max(maxX, p[i]);
      }
    }
    const errors = window.wirecad.reports().filter((r) => r.error !== undefined);
    return {
      volume,
      minX,
      maxX,
      nodes: window.wirecad.graph.nodeCount,
      error: errors[0]?.error ?? null,
    };
  };
  /** Which node feeds a port, by label, for reading the chain back. */
  window.__feeds = (label, port) => {
    const { graph } = window.wirecad;
    const id = window.__idOf(label);
    if (id === null) return null;
    const edge = graph.incomingEdge(id, port);
    if (edge === undefined) return null;
    const source = graph.getNode(edge.from.node);
    return source?.label ?? source?.type ?? null;
  };
  window.__reset = async () => {
    const { graph } = window.wirecad;
    graph.restore({ version: 1, nodes: [], edges: [] });
    window.wirecad.starter(graph);
    window.wirecad.select(null);
    await window.__settle();
  };
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};

const openMove = async (label) => {
  await page.evaluate((name) => window.wirecad.select(window.__idOf(name)), label);
  await page.getByRole('button', { name: 'Solid', exact: true }).click();
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await page.locator('.feature-dialog').waitFor({ state: 'visible' });
};
const setNumber = async (index, value) => {
  await page.locator('.feature-dialog input[type=number]').nth(index).fill(String(value));
  await page.waitForTimeout(400);
};
const create = async () => {
  await page.locator('.feature-dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForTimeout(500);
};

// ----------------------------------------------------- the whole thing shifts

await page.evaluate(() => window.__reset());
const before = await page.evaluate(() => window.__model());

await openMove('Bore');
await setNumber(0, 25);
const previewed = await page.evaluate(() => window.__model());
check(
  'a move shows before Create',
  Math.abs(previewed.minX - 25) < 0.01 && Math.abs(previewed.volume - before.volume) < 5,
  previewed.error ?? `x from ${previewed.minX.toFixed(1)} · ${previewed.volume.toFixed(0)} mm3`,
);

await create();
const appended = await page.evaluate(() => window.__model());
check(
  'at the end, all of it goes',
  Math.abs(appended.minX - 25) < 0.01 &&
    Math.abs(appended.maxX - 85) < 0.01 &&
    Math.abs(appended.volume - before.volume) < 5,
  appended.error ?? `x ${appended.minX.toFixed(1)}–${appended.maxX.toFixed(1)} · ${appended.volume.toFixed(0)} mm3`,
);
check(
  'reading the body it moved ',
  (await page.evaluate(() => window.__feeds('solid.move', 'solid'))) === 'Bore',
  String(await page.evaluate(() => window.__feeds('solid.move', 'solid'))),
);

// ------------------------------------------------------- three arrows, one per axis

await page.evaluate(() => window.__reset());
await openMove('Body');
await page.waitForTimeout(500);

const arrows = await page.evaluate(() => window.wirecad.handles());
const apart = arrows.length === 3 &&
  arrows.every((a, i) => arrows.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) > 20));
check(
  'three arrows, apart      ',
  apart,
  arrows.map((a) => `${Math.round(a.x)},${Math.round(a.y)}`).join(' · ') || 'none',
);

let draggedTo = null;
if (arrows.length === 3) {
  // The X arrow, dragged along the way it points on screen.
  const x = arrows[0];
  await page.mouse.move(x.x, x.y);
  await page.mouse.down();
  await page.mouse.move(x.x + 60, x.y + 30, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  draggedTo = await page.evaluate(() =>
    Number(document.querySelectorAll('.feature-dialog input[type=number]')[0].value),
  );
}
check('dragging one sets its number', draggedTo !== null && draggedTo !== 0, `X = ${draggedTo}`);

// ------------------------------------------------- the bore stays where it was

await setNumber(0, 25);
await create();
const spliced = await page.evaluate(() => window.__model());
check(
  'the bore is cut from the move',
  (await page.evaluate(() => window.__feeds('Bore', 'target'))) === 'solid.move',
  String(await page.evaluate(() => window.__feeds('Bore', 'target'))),
);
// The block moved 25 mm out from under its own bore, so the hole now runs off
// the edge and takes about 500 mm3 less material with it.
check(
  'in the middle, it stays put',
  Math.abs(spliced.minX - 25) < 0.01 && spliced.volume > 44200 && spliced.volume < 44900,
  spliced.error ?? `x from ${spliced.minX.toFixed(1)} · ${spliced.volume.toFixed(0)} mm3`,
);

// ---------------------------------------------------------- cancelling it all

await page.evaluate(() => window.__reset());
const fresh = await page.evaluate(() => window.__model());
await openMove('Body');
await setNumber(0, 25);
await page.locator('.feature-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await page.waitForTimeout(500);

const cancelled = await page.evaluate(() => window.__model());
check(
  'cancelling gives it back ',
  cancelled.nodes === fresh.nodes &&
    Math.abs(cancelled.volume - fresh.volume) < 1 &&
    Math.abs(cancelled.minX) < 0.01,
  `${cancelled.nodes} nodes · ${cancelled.volume.toFixed(0)} mm3 · x from ${cancelled.minX.toFixed(1)}`,
);
check(
  'with the chain closed over',
  (await page.evaluate(() => window.__feeds('Bore', 'target'))) === 'Body',
  String(await page.evaluate(() => window.__feeds('Bore', 'target'))),
);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
