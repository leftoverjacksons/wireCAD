/**
 * Checks the node editor's context menu: that it says what deleting a node
 * would do before it does it, that a suppressed feature is held back rather
 * than removed, and that renaming, hiding and reopening are where they say.
 *
 *   npm run dev
 *   npm run verify:menu
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
  // The volume of whatever is on screen, from the triangles themselves: the one
  // measure that says whether a feature actually happened.
  window.__volume = async () => {
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
    await window.__settle();
  };
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};

/** Right-click a node's header and read back what the menu offers. */
async function openMenu(label) {
  const id = await page.evaluate((name) => window.__idOf(name), label);
  await page.locator(`.node[data-node-id="${id}"] .node-header`).click({ button: 'right' });
  await page.locator('.node-menu').waitFor({ state: 'visible' });
  return page.evaluate(() => {
    const menu = document.querySelector('.node-menu');
    return {
      title: menu.querySelector('.node-menu-title')?.textContent ?? '',
      items: [...menu.querySelectorAll('.node-menu-item')].map((item) => ({
        action: item.dataset.action,
        label: item.querySelector('.node-menu-label')?.textContent ?? '',
        detail: item.querySelector('.node-menu-detail')?.textContent ?? null,
        disabled: item.disabled,
      })),
    };
  });
}

const choose = (action) => page.locator(`.node-menu-item[data-action="${action}"]`).click();
const entry = (menu, action) => menu.items.find((item) => item.action === action);

// ------------------------------------------------- what the menu says it will do

await page.evaluate(() => window.__reset());

const bore = await openMenu('Bore');
check(
  'the menu names the node   ',
  bore.title === 'Bore',
  `${bore.title} · ${bore.items.map((i) => i.action).join(',')}`,
);
check(
  'suppress says what passes ',
  entry(bore, 'suppress')?.detail === 'hands its Body on untouched' &&
    entry(bore, 'suppress')?.disabled === false,
  entry(bore, 'suppress')?.detail ?? 'missing',
);
check(
  'nothing reads it, so no   ',
  entry(bore, 'delete')?.detail === null && entry(bore, 'delete-branch') === undefined,
  `delete: ${entry(bore, 'delete')?.detail ?? 'nothing said'}`,
);
check(
  'edit says why it cannot   ',
  entry(bore, 'edit')?.disabled === true &&
    entry(bore, 'edit')?.detail === 'Nothing here reopens for editing',
  entry(bore, 'edit')?.detail ?? 'missing',
);

// A branch counts only what would have nothing left to read: the bore survives
// losing the body, because its own profile still feeds it.
const bodyProfile = await openMenu('Body profile');
check(
  'a branch counts the lost  ',
  entry(bodyProfile, 'delete-branch')?.detail === '1 node after it goes too',
  entry(bodyProfile, 'delete-branch')?.detail ?? 'not offered',
);
await page.keyboard.press('Escape');

// ------------------------------------------------------- suppressing a feature

const bored = await page.evaluate(() => window.__volume());
await openMenu('Bore');
await choose('suppress');
const suppressed = await page.evaluate(() => window.__volume());
const greyed = await page.evaluate(() => {
  const id = window.__idOf('Bore');
  return document.querySelector(`.node[data-node-id="${id}"]`)?.dataset.suppressed === 'true';
});

// A 60 x 40 x 20 block is 48000 mm3; the bore takes about 4020 of it away.
check(
  'suppressing holds it back ',
  Math.abs(suppressed - 48000) < 400 && bored < suppressed - 3000,
  `${bored.toFixed(0)} mm3 bored → ${suppressed.toFixed(0)} mm3 held back`,
);
check('and the node stays, greyed', greyed, greyed ? 'greyed' : 'not marked');

const after = await openMenu('Bore');
check(
  'the menu offers it back   ',
  entry(after, 'unsuppress') !== undefined && entry(after, 'suppress') === undefined,
  after.items.map((i) => i.action).join(','),
);
await choose('unsuppress');
const restored = await page.evaluate(() => window.__volume());
check(
  'and letting go cuts again ',
  Math.abs(restored - bored) < 1,
  `${restored.toFixed(0)} mm3`,
);

// ------------------------------------------------------ deleting from the middle

// A fillet on the end of the chain, so the bore has something reading it.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  const bore = window.__idOf('Bore');
  graph.addNode('solid.fillet', { id: 'roundoff', label: 'Roundoff', inputs: { radius: 2 } });
  graph.connect({ node: bore, port: 'solid' }, { node: 'roundoff', port: 'solid' });
  await window.__settle();
});

const middle = await openMenu('Bore');
check(
  'delete says what takes over',
  entry(middle, 'delete')?.detail === '1 node reads Body instead',
  entry(middle, 'delete')?.detail ?? 'nothing said',
);
await choose('delete');

const healed = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const source = graph.incomingEdge('roundoff', 'solid');
  return {
    gone: window.__idOf('Bore') === null,
    reads: source === undefined ? null : (graph.getNode(source.from.node)?.label ?? null),
    errors: window.wirecad.reports().filter((r) => r.error !== undefined).length,
  };
});
check(
  'and the chain closes over ',
  healed.gone && healed.reads === 'Body' && healed.errors === 0,
  `${healed.gone ? 'gone' : 'still there'} · roundoff reads ${healed.reads} · ${healed.errors} errors`,
);

// --------------------------------------------------------- renaming and hiding

await openMenu('Roundoff');
await choose('rename');
await page.locator('.node-rename').fill('Broken edges');
await page.keyboard.press('Enter');
const renamed = await page.evaluate(() => window.__idOf('Broken edges') !== null);
check('rename takes on the node  ', renamed, renamed ? 'renamed' : 'not renamed');

await openMenu('Broken edges');
await choose('hide');
const hidden = await page.evaluate(async () => {
  // Selecting it is what the right-click did, and a selected node is drawn as a
  // ghost whatever its setting says. The question is what the model shows.
  window.wirecad.select(null);
  await window.__settle();
  const id = window.__idOf('Broken edges');
  return { drawn: window.wirecad.visible().includes(id), id };
});
check('hide takes it off screen  ', !hidden.drawn, hidden.drawn ? 'still drawn' : 'hidden');

const pinned = await openMenu('Broken edges');
check(
  'and the rule is offered back',
  entry(pinned, 'show') !== undefined && entry(pinned, 'auto') !== undefined,
  pinned.items.map((i) => i.action).join(','),
);
await choose('auto');
const automatic = await page.evaluate(async () => {
  await window.__settle();
  const id = window.__idOf('Broken edges');
  return window.wirecad.visible().includes(id);
});
check('letting the model decide  ', automatic, automatic ? 'drawn again' : 'still hidden');

// --------------------------------------------------------------- what reopens

await page.evaluate(() => {
  window.wirecad.graph.addNode('sketch.constrained', { id: 'drawing', label: 'Drawing' });
});
const sketch = await openMenu('Drawing');
check(
  'a sketch reopens for editing',
  entry(sketch, 'edit')?.disabled === false,
  entry(sketch, 'edit')?.disabled === false ? 'offered' : 'refused',
);
await page.keyboard.press('Escape');
const closed = await page.locator('.node-menu').count();
check('escape closes the menu    ', closed === 0, `${closed} menus open`);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
