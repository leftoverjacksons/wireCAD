/**
 * Checks reopening a feature that already exists: its own values in the dialog,
 * changed live on the node itself, kept by Done and put back by Cancel.
 *
 *   npm run dev
 *   npm run verify:edit
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
  window.__volume = async () => {
    if (!window.wirecad.dialog.isOpen) window.wirecad.select(null);
    await window.__settle();
    let total = 0;
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
      total += Math.abs(signed) / 6;
    }
    return total;
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

/** Reopen a node through its own context menu, the way a person would. */
async function editViaMenu(label) {
  const id = await page.evaluate((name) => window.__idOf(name), label);
  await page.locator(`.node[data-node-id="${id}"] .node-header`).click({ button: 'right' });
  await page.locator('.node-menu').waitFor({ state: 'visible' });
  await page.locator('.node-menu-item[data-action="edit"]').click();
  await page.locator('.feature-dialog').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

const dialogState = () =>
  page.evaluate(() => {
    const dialog = document.querySelector('.feature-dialog');
    return {
      title: dialog.querySelector('.feature-title')?.textContent ?? '',
      chips: [...dialog.querySelectorAll('.feature-chip')].map((c) => c.textContent),
      numbers: [...dialog.querySelectorAll('input[type=number]')].map((f) => Number(f.value)),
      choices: [...dialog.querySelectorAll('.feature-select')].map((s) => s.value),
      picks: dialog.querySelectorAll('.feature-pick').length,
      action: [...dialog.querySelectorAll('.tool-button')].map((b) => b.textContent),
    };
  });

// ------------------------------------------------ what a reopened feature says

await page.evaluate(() => window.__reset());
const bored = await page.evaluate(() => window.__volume());
// Taken before the dialog opens: an edit captures one step of its own, and what
// is being checked is that cancelling leaves none of it behind.
const undoBefore = await page.evaluate(() => window.wirecad.history.canUndo);

await editViaMenu('Bore');
const opened = await dialogState();
check(
  'it opens on the node      ',
  opened.title === 'Edit Extrude' && opened.numbers[0] === 40 && opened.choices.includes('Cut'),
  `${opened.title} · ${opened.numbers.join(',')} · ${opened.choices.join(',')}`,
);
check(
  'showing what it is built on',
  opened.chips.some((c) => c.includes('Bore profile')) && opened.chips.some((c) => c === 'Body'),
  opened.chips.join(' · '),
);
check(
  'and not offering to rewire ',
  opened.picks === 0 && opened.action.includes('Done'),
  `${opened.picks} pick buttons · ${opened.action.join('/')}`,
);

// ------------------------------------------------------- changed live, then put back

await page.locator('.feature-dialog input[type=number]').first().fill('10');
await page.waitForTimeout(400);
const shallow = await page.evaluate(() => window.__volume());
// A 10 mm blind bore in a 20 mm block leaves about 2000 mm3 more material.
check(
  'a changed number shows now',
  shallow > 45800 && shallow < 46200,
  `${shallow.toFixed(0)} mm3, was ${bored.toFixed(0)}`,
);

await page.locator('.feature-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await page.waitForTimeout(500);
const cancelled = await page.evaluate(() => window.__volume());
const undoAfter = await page.evaluate(() => window.wirecad.history.canUndo);
check(
  'Cancel puts it back       ',
  Math.abs(cancelled - bored) < 1,
  `${cancelled.toFixed(0)} mm3`,
);
check(
  'and leaves no undo step   ',
  undoAfter === undoBefore,
  `undo ${undoBefore} → ${undoAfter}`,
);

// ------------------------------------------------------------ kept, and undoable

await editViaMenu('Bore');
await page.locator('.feature-dialog input[type=number]').first().fill('10');
await page.waitForTimeout(400);
await page.locator('.feature-dialog').getByRole('button', { name: 'Done', exact: true }).click();
await page.waitForTimeout(500);

const kept = await page.evaluate(() => window.__volume());
check('Done keeps the change    ', kept > 45800 && kept < 46200, `${kept.toFixed(0)} mm3`);

await page.evaluate(() => window.wirecad.history.undo());
const undone = await page.evaluate(() => window.__volume());
check(
  'and one undo reverses it  ',
  Math.abs(undone - bored) < 1,
  `${undone.toFixed(0)} mm3`,
);

// ------------------------------------------- a reopened move brings its gizmo back

await page.evaluate(() => window.__reset());
await page.evaluate(() => window.wirecad.select(window.__idOf('Bore')));
await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.getByRole('button', { name: 'Move', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible' });
await page.locator('.feature-dialog input[type=number]').first().fill('25');
await page.waitForTimeout(400);
await page.locator('.feature-dialog').getByRole('button', { name: 'Create', exact: true }).click();
await page.waitForTimeout(600);

await editViaMenu('solid.move');
await page.waitForTimeout(500);
const reopened = await dialogState();
const arrows = await page.evaluate(() => window.wirecad.handles());
check(
  'a move reopens at its value',
  reopened.title === 'Edit Move' && reopened.numbers[0] === 25,
  `${reopened.title} · ${reopened.numbers.join(',')}`,
);
check(
  'with its arrows back      ',
  arrows.length === 3,
  `${arrows.length} arrows`,
);

await page.locator('.feature-dialog input[type=number]').first().fill('40');
await page.waitForTimeout(400);
await page.locator('.feature-dialog').getByRole('button', { name: 'Done', exact: true }).click();
await page.waitForTimeout(500);
const moved = await page.evaluate(async () => {
  await window.__settle();
  let minX = Infinity;
  for (const mesh of window.wirecad.meshes()) {
    if (mesh.kind !== 'solid') continue;
    for (let i = 0; i < mesh.positions.length; i += 3) minX = Math.min(minX, mesh.positions[i]);
  }
  return minX;
});
check('and the body follows it  ', Math.abs(moved - 40) < 0.01, `x from ${moved.toFixed(1)}`);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
