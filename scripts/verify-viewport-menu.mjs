/**
 * Checks the menu a right-click in the 3D view opens: scoped to the body under
 * the cursor and the face it landed on, offering the same things for a body as
 * the graph offers for the node that made it.
 *
 *   npm run dev
 *   npm run verify:viewport-menu
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
    throw new Error('solve did not settle');
  };
  window.__idOf = (label) => {
    const node = window.wirecad.graph.allNodes().find((n) => (n.label ?? n.type) === label);
    return node?.id ?? null;
  };
  window.__reset = async () => {
    window.wirecad.rollBack(null);
    const { graph } = window.wirecad;
    graph.restore({ version: 1, nodes: [], edges: [] });
    window.wirecad.starter(graph);
    window.wirecad.select(null);
    await window.__settle();
  };
  /**
   * A point on screen that really lands on a flat face, or on a curved one.
   *
   * Projecting a face's own centroid is not enough: the top of a bored block
   * has its centroid over the hole, so the ray goes straight down it. This asks
   * the viewport what each point actually hits.
   */
  window.__pointOnFace = (wantPlanar) => {
    // Whatever solid is on screen now, which is not always the node the model
    // started with: deleting a face puts a new node at the end of the chain.
    const ghosts = window.wirecad.viewport.ghosts ?? new Map();
    const mesh = window.wirecad
      .meshes()
      .find((m) => m.kind === 'solid' && !ghosts.has(m.nodeId));
    if (mesh === undefined) return null;
    const bore = mesh.nodeId;

    const rect = window.wirecad.viewport.canvas.getBoundingClientRect();
    for (let y = rect.top + 20; y < rect.bottom - 20; y += 7) {
      for (let x = rect.left + 20; x < rect.right - 20; x += 7) {
        const hit = window.wirecad.faceAt(x, y);
        if (hit === null || hit.nodeId !== bore || hit.faceIndex === null) continue;
        const face = mesh.faces[hit.faceIndex];
        if (face === undefined || face.planar !== wantPlanar) continue;
        return { x, y };
      }
    }
    return null;
  };
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};

const readMenu = () =>
  page.evaluate(() => {
    const menu = document.querySelector('.menu');
    if (menu === null) return null;
    return {
      title: menu.querySelector('.menu-title')?.textContent ?? '',
      items: [...menu.querySelectorAll('.menu-item')].map((item) => ({
        action: item.dataset.action,
        label: item.querySelector('.menu-label')?.textContent ?? '',
        detail: item.querySelector('.menu-detail')?.textContent ?? null,
        disabled: item.disabled,
      })),
    };
  });

const rightClickAt = async (at) => {
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForTimeout(400);
};

await page.evaluate(() => window.__reset());

// ------------------------------------------------- a right-click on the body

const top = await page.evaluate(() => window.__pointOnFace(true));
await rightClickAt(top);
const onTop = await readMenu();
check(
  'a menu on the body        ',
  onTop !== null && onTop.title === 'Bore',
  onTop === null ? 'no menu' : onTop.title,
);
check(
  'offering what the node does',
  onTop !== null &&
    ['edit', 'roll-back', 'rename', 'hide', 'suppress', 'delete'].every((action) =>
      onTop.items.some((item) => item.action === action),
    ),
  onTop === null ? 'no menu' : onTop.items.map((i) => i.action).join(','),
);
check(
  'and a flat face to sketch on',
  onTop !== null &&
    onTop.items[0]?.action === 'sketch-on-face' &&
    onTop.items[0]?.disabled === false,
  onTop === null ? 'no menu' : `${onTop.items[0]?.action} · ${onTop.items[0]?.disabled}`,
);

// ------------------------------------------ a face a sketch cannot sit on

await page.keyboard.press('Escape');
const curved = await page.evaluate(() => window.__pointOnFace(false));
await rightClickAt(curved);
const onBore = await readMenu();
check(
  'a curved face says why not',
  onBore !== null &&
    onBore.items[0]?.action === 'sketch-on-face' &&
    onBore.items[0]?.disabled === true &&
    onBore.items[0]?.detail === 'That face is not flat',
  onBore === null ? 'no menu' : `${onBore.items[0]?.detail} · disabled ${onBore.items[0]?.disabled}`,
);

// ----------------------------------------------- the entries actually work

await page.keyboard.press('Escape');
await rightClickAt(top);
await page.locator('.menu-item[data-action="roll-back"]').click();
await page.waitForTimeout(600);
const rolled = await page.evaluate(async () => {
  await window.__settle();
  return window.wirecad.rolledBackTo() === window.__idOf('Bore');
});
check('an entry does what it says', rolled, rolled ? 'rolled back to Bore' : 'nothing happened');
await page.evaluate(() => window.wirecad.rollBack(null));

// ------------------------------------------------- sketching on a picked face

await page.waitForTimeout(400);
await rightClickAt(top);
await page.locator('.menu-item[data-action="sketch-on-face"]').click();
await page.waitForTimeout(800);
const sketching = await page.evaluate(() => ({
  session: document.body.classList.contains('sketching'),
  onFace: window.wirecad.graph.allNodes().some((n) => n.type === 'face.plane'),
}));
check(
  'sketch on this face opens one',
  sketching.session && sketching.onFace,
  `session ${sketching.session} · face plane ${sketching.onFace}`,
);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// ------------------------------------------------ right-dragging is not a menu

await page.evaluate(() => window.__reset());
const from = await page.evaluate(() => window.__pointOnFace(true));
await page.mouse.move(from.x, from.y);
await page.mouse.down({ button: 'right' });
await page.mouse.move(from.x + 90, from.y + 40, { steps: 8 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(400);
const afterDrag = await readMenu();
check(
  'a right-drag pans instead ',
  afterDrag === null,
  afterDrag === null ? 'no menu' : 'a menu opened',
);

// --------------------------------------------------------------- delete face

await page.evaluate(() => window.__reset());
const bored = await page.evaluate(async () => {
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
});

const wall = await page.evaluate(() => window.__pointOnFace(false));
await rightClickAt(wall);
await page.locator('.menu-item[data-action="delete-face"]').click();
await page.waitForTimeout(900);

const healed = await page.evaluate(async () => {
  window.wirecad.select(null);
  await window.__settle();
  const ghosts = window.wirecad.viewport.ghosts ?? new Map();
  let total = 0;
  for (const mesh of window.wirecad.meshes()) {
    if (mesh.kind !== 'solid' || ghosts.has(mesh.nodeId)) continue;
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
  return {
    volume: total,
    node: window.wirecad.graph.allNodes().some((n) => n.type === 'solid.defeature'),
    error: window.wirecad.reports().find((r) => r.error)?.error ?? null,
  };
});
// The bore's wall taken off and the gap healed over: a solid block again.
check(
  'deleting a face heals it  ',
  healed.node && Math.abs(healed.volume - 48000) < 5,
  healed.error ?? `${healed.volume.toFixed(0)} mm3, was ${bored.toFixed(0)}`,
);

// A face that cannot go says so rather than quietly doing nothing.
const flat = await page.evaluate(() => window.__pointOnFace(true));
await rightClickAt(flat);
await page.locator('.menu-item[data-action="delete-face"]').click();
await page.waitForTimeout(900);
const refused = await page.evaluate(async () => {
  await window.__settle();
  const report = window.wirecad
    .reports()
    .find((r) => r.error !== undefined);
  return report?.error ?? null;
});
check(
  'and an outer face refuses ',
  refused !== null && refused.includes('nothing to heal the gap with'),
  refused ?? 'no complaint',
);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
