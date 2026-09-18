/**
 * Checks looking at the model as it was: rolled back to a node, that node's own
 * result is on screen again, what is built on it is an outline, and a feature
 * built there goes in at that point rather than on the end. Editing a feature
 * rolls the view back to it for as long as the dialog is up.
 *
 *   npm run dev
 *   npm run verify:rollback
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
  window.__name = (id) => {
    const node = window.wirecad.graph.getNode(id);
    return node?.label ?? node?.type ?? id;
  };
  /** What is on screen, and how each of it is drawn. */
  window.__view = async () => {
    await window.__settle();
    const { viewport } = window.wirecad;
    const ghosts = viewport.ghosts ?? new Map();
    const shown = window.wirecad.visible();
    return {
      model: shown.filter((id) => !ghosts.has(id)).map(window.__name).sort(),
      outlined: [...ghosts]
        .filter(([, mode]) => mode === 'edges')
        .map(([id]) => window.__name(id))
        .sort(),
      volume: (() => {
        let total = 0;
        for (const mesh of window.wirecad.meshes()) {
          if (mesh.kind !== 'solid') continue;
          if (ghosts.has(mesh.nodeId)) continue;
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
      })(),
    };
  };
  window.__reset = async () => {
    const { graph } = window.wirecad;
    window.wirecad.rollBack(null);
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

const openMenu = async (label) => {
  const id = await page.evaluate((name) => window.__idOf(name), label);
  await page.locator(`.node[data-node-id="${id}"] .node-header`).click({ button: 'right' });
  await page.locator('.node-menu').waitFor({ state: 'visible' });
};
const choose = (action) => page.locator(`.node-menu-item[data-action="${action}"]`).click();

// ------------------------------------------------------- what rolling back shows

await page.evaluate(() => window.__reset());
const now = await page.evaluate(() => window.__view());
check(
  'the model, to start       ',
  now.model.join(',') === 'Bore' && now.outlined.length === 0,
  `${now.model.join(',')} · ${now.outlined.join(',') || 'no outlines'}`,
);

await openMenu('Body');
await choose('roll-back');
const back = await page.evaluate(() => window.__view());
// The block before the bore: 60 x 40 x 20 with nothing taken out of it.
check(
  'the block is back on screen',
  back.model.join(',') === 'Body' && Math.abs(back.volume - 48000) < 5,
  `${back.model.join(',')} · ${back.volume.toFixed(0)} mm3`,
);
check(
  'and what is built on it   ',
  back.outlined.join(',') === 'Bore',
  back.outlined.join(',') || 'nothing outlined',
);

const marked = await page.evaluate(() => {
  const body = window.__idOf('Body');
  const bore = window.__idOf('Bore');
  return {
    marker: document.querySelector(`.node[data-node-id="${body}"]`)?.classList.contains('node-marker'),
    beyond: document.querySelector(`.node[data-node-id="${bore}"]`)?.classList.contains('node-beyond'),
  };
});
check(
  'the graph says where we are',
  marked.marker === true && marked.beyond === true,
  `marker ${marked.marker} · dimmed ${marked.beyond}`,
);

// -------------------------------------------- a feature built there goes in there

await page.evaluate(() => window.wirecad.select(window.__idOf('Body')));
await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.getByRole('button', { name: 'Move', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible' });
await page.locator('.feature-dialog input[type=number]').nth(2).fill('15');
await page.waitForTimeout(400);
await page.locator('.feature-dialog').getByRole('button', { name: 'Create', exact: true }).click();
await page.waitForTimeout(600);

const inserted = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const bore = window.__idOf('Bore');
  const source = graph.incomingEdge(bore, 'target');
  return {
    boreReads: source === undefined ? null : window.__name(source.from.node),
    marker: window.__name(window.wirecad.rolledBackTo()),
  };
});
check(
  'built at the point looked at',
  inserted.boreReads === 'solid.move',
  `the bore is cut from ${inserted.boreReads}`,
);
check(
  'and the view stays there  ',
  inserted.marker === 'solid.move',
  `rolled back to ${inserted.marker}`,
);

// ------------------------------------------------------------ and back to now

await openMenu('Bore');
await choose('return');
const returned = await page.evaluate(() => window.__view());
check(
  'returning shows the model ',
  returned.model.join(',') === 'Bore' && returned.outlined.length === 0,
  `${returned.model.join(',')} · ${returned.outlined.join(',') || 'no outlines'}`,
);

// -------------------------------------------- editing looks at the moment it was made

await page.evaluate(() => window.__reset());
await openMenu('Bore');
await choose('edit');
await page.locator('.feature-dialog').waitFor({ state: 'visible' });
await page.waitForTimeout(400);

const editing = await page.evaluate(async () => ({
  ...(await window.__view()),
  marker: window.__name(window.wirecad.rolledBackTo()),
}));
check(
  'editing rolls back to it  ',
  editing.marker === 'Bore' && editing.model.join(',') === 'Bore',
  `at ${editing.marker} · ${editing.model.join(',')}`,
);

// A fillet after the bore, so editing the bore has something to step out of the way.
await page.locator('.feature-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
await page.waitForTimeout(400);
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.addNode('solid.fillet', { id: 'round', label: 'Round', inputs: { radius: 2 } });
  graph.connect({ node: window.__idOf('Bore'), port: 'solid' }, { node: 'round', port: 'solid' });
  await window.__settle();
});

await openMenu('Bore');
await choose('edit');
await page.locator('.feature-dialog').waitFor({ state: 'visible' });
await page.waitForTimeout(500);
const mid = await page.evaluate(async () => ({
  ...(await window.__view()),
  marker: window.__name(window.wirecad.rolledBackTo()),
}));
check(
  'the feature after it steps aside',
  mid.model.join(',') === 'Bore' && mid.outlined.join(',') === 'Round',
  `${mid.model.join(',')} · outlined ${mid.outlined.join(',') || 'nothing'}`,
);

await page.locator('.feature-dialog').getByRole('button', { name: 'Done', exact: true }).click();
await page.waitForTimeout(600);
const after = await page.evaluate(async () => ({
  ...(await window.__view()),
  marker: window.wirecad.rolledBackTo(),
}));
check(
  'and closing gives it back ',
  after.marker === null && after.model.join(',') === 'Round' && after.outlined.length === 0,
  `${after.marker ?? 'now'} · ${after.model.join(',')}`,
);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
