/**
 * Checks that clicking a node says what it is responsible for: its result put
 * back on screen as a ghost when something later has replaced it, and the edges
 * lit up when the node only points at some.
 *
 *   npm run dev
 *   npm run verify:ghost
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
  // Who is on screen, and which of them are ghosts rather than the model.
  window.__shown = async () => {
    await window.__settle();
    const { graph, viewport } = window.wirecad;
    const name = (id) => graph.getNode(id)?.label ?? graph.getNode(id)?.type ?? id;
    return {
      shown: window.wirecad.visible().map(name).sort(),
      ghosts: [...(viewport.ghosts ?? new Map())].map(([id, mode]) => `${name(id)}:${mode}`).sort(),
    };
  };
  window.__pick = (label) => {
    const node = window.wirecad.graph.allNodes().find((n) => (n.label ?? n.type) === label);
    window.wirecad.select(node?.id ?? null);
    return node?.id ?? null;
  };
});

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${detail}`);
};

// The starter: a profile, a body, a bore profile, the bored body.
await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  window.wirecad.starter(graph);
  await window.__settle();
});

const plain = await page.evaluate(() => window.__shown());
check('only the model, to start ', plain.shown.join(',') === 'Bore' && plain.ghosts.length === 0,
  `${plain.shown.join(',')} · ${plain.ghosts.join(',') || 'no ghosts'}`);

await page.evaluate(() => window.__pick('Body profile'));
const profile = await page.evaluate(() => window.__shown());
check('a used-up profile returns', profile.shown.includes('Body profile') &&
  profile.ghosts.includes('Body profile:faint'),
  `${profile.shown.join(',')} · ${profile.ghosts.join(',')}`);

await page.evaluate(() => window.__pick('Body'));
const body = await page.evaluate(() => window.__shown());
check('so does a replaced body  ', body.shown.includes('Body') && body.ghosts.includes('Body:faint'),
  `${body.shown.join(',')} · ${body.ghosts.join(',')}`);

await page.evaluate(() => window.wirecad.select(null));
const cleared = await page.evaluate(() => window.__shown());
check('and clicking off ends it ', cleared.shown.join(',') === 'Bore' && cleared.ghosts.length === 0,
  `${cleared.shown.join(',')} · ${cleared.ghosts.join(',') || 'no ghosts'}`);

// A fillet on three edges, so there is a selection node to point at them.
await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.getByRole('button', { name: 'Fillet', exact: true }).click();
await page.locator('.feature-dialog').waitFor({ state: 'visible' });

const verticals = await page.evaluate(() => {
  const bore = window.wirecad.graph.allNodes().find((n) => n.label === 'Bore');
  const mesh = window.wirecad.meshes().find((m) => m.nodeId === bore?.id);
  if (mesh === undefined) return [];
  return mesh.edges
    .map((edge, index) => ({ index, edge }))
    .filter(({ edge }) => Math.abs(edge.direction.z) > 0.9 && edge.length > 15)
    .slice(0, 3)
    .map(({ edge }) => window.wirecad.viewport.screenPositionOf(edge.midpoint));
});
for (const at of verticals) {
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(400);
}
await page.locator('.feature-dialog').getByRole('button', { name: 'Create', exact: true }).click();
await page.waitForTimeout(600);

await page.evaluate(() => window.__pick('3 edges'));
const edges = await page.evaluate(async () => {
  const shown = await window.__shown();
  const { graph, viewport } = window.wirecad;
  const bore = graph.allNodes().find((n) => n.label === 'Bore');
  return {
    ...shown,
    lit: viewport.chosenEdges?.get(bore?.id)?.size ?? 0,
  };
});
check('a selection lights edges ', edges.lit === verticals.length, `${edges.lit} of ${verticals.length} lit`);
check('on the body it came from ', edges.ghosts.includes('Bore:edges'),
  edges.ghosts.join(',') || 'no ghosts');

await page.evaluate(() => window.wirecad.select(null));
const after = await page.evaluate(async () => {
  const shown = await window.__shown();
  const { graph, viewport } = window.wirecad;
  const bore = graph.allNodes().find((n) => n.label === 'Bore');
  return { ...shown, lit: viewport.chosenEdges?.get(bore?.id)?.size ?? 0 };
});
check('and lets go of them after', after.lit === 0 && after.ghosts.length === 0,
  `${after.lit} lit · ${after.ghosts.join(',') || 'no ghosts'}`);

console.log(pageErrors.length === 0 ? 'no page errors' : pageErrors.slice(0, 3));
await browser.close();
if (failures > 0 || pageErrors.length > 0) process.exitCode = 1;
