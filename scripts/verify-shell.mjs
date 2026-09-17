/**
 * Exercises Shell against the real kernel, because the geometry path cannot run
 * under Node. Shell has two implementations — the kernel's own MakeThickSolidByJoin
 * and a modelled offset-and-subtract fallback — and which one runs depends on the
 * input, so each case here pins down a different branch.
 *
 *   npm run dev
 *   npm run verify:shell
 */
import { chromium } from 'playwright';

const url = process.env.WIRECAD_URL ?? 'http://localhost:5173/';
const executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
  .locator('#kernel-status')
  .filter({ hasText: 'kernel ready' })
  .waitFor({ timeout: 180_000 });

/** Rebuild the document as profile → extrude → [fillet] → shell and solve it. */
async function solve({ radius, thickness }) {
  const before = await page.evaluate(() => window.wirecad.solves());
  await page.evaluate(
    ({ radius, thickness }) => {
      const { graph } = window.wirecad;
      graph.restore({ version: 1, nodes: [], edges: [] });
      const rect = graph.addNode('sketch.rectangle', {
        inputs: { width: 60, height: 40 },
      });
      const extrude = graph.addNode('solid.extrude', { inputs: { distance: 20 } });
      graph.connect(
        { node: rect.id, port: 'profile' },
        { node: extrude.id, port: 'profile' },
      );

      let body = { node: extrude.id, port: 'solid' };
      if (radius !== null) {
        const fillet = graph.addNode('solid.fillet', { inputs: { radius } });
        graph.connect(body, { node: fillet.id, port: 'solid' });
        body = { node: fillet.id, port: 'result' };
      }

      // A fixed id: the starter document reuses n1..n14, so a generated id can
      // collide with a stale report from the previous solve.
      const shell = graph.addNode('solid.shell', {
        id: 'shellUnderTest',
        inputs: { thickness, nx: 0, ny: 0, nz: -1, rank: 0 },
      });
      graph.connect(body, { node: shell.id, port: 'solid' });
      window.__shellNode = shell.id;
      window.wirecad.solve();
    },
    { radius, thickness },
  );

  await page.waitForFunction(
    (seen) =>
      window.wirecad.solves() > seen &&
      window.wirecad.reports().some((r) => r.nodeId === 'shellUnderTest'),
    before,
    { timeout: 120_000 },
  );
  return page.evaluate(() => {
    const report = window.wirecad.reports().find((r) => r.nodeId === window.__shellNode);
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === window.__shellNode);
    // Divergence theorem over the triangulation: exact for a closed surface, and
    // the only way to tell a real hollow from a no-op that returned the solid.
    let volume = null;
    if (mesh !== undefined) {
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
      volume = Math.abs(total) / 6;
    }
    return {
      report,
      volume,
      triangles: mesh === undefined ? 0 : mesh.indices.length / 3,
    };
  });
}

// A 60x40x20 body. Solid volume is ~48000 mm3 less what the fillets remove, so a
// genuine hollow lands near 11-12k; anything close to the solid figure is a no-op.
const cases = [
  { name: 'no fillet, wall 2     ', radius: null, thickness: 2, solid: 48000 },
  { name: 'fillet 3, wall 2      ', radius: 3, thickness: 2, solid: 47109 },
  { name: 'fillet 5, wall 2      ', radius: 5, thickness: 2, solid: 45592 },
  { name: 'fillet 1.5, wall 1    ', radius: 1.5, thickness: 1, solid: 47773 },
  { name: 'fillet 2, wall 2 (r=t)', radius: 2, thickness: 2, solid: 47599 },
  { name: 'fillet 1, wall 2 (r<t)', radius: 1, thickness: 2, solid: 47898 },
];

let failures = 0;
for (const testCase of cases) {
  const { report, volume, triangles } = await solve(testCase);
  const errored = report?.error !== undefined;
  // Hollow to within a quarter of the solid, or refuse. Returning the solid
  // untouched, or an empty shape, is the failure mode worth catching.
  const hollow = volume !== null && volume > 1 && volume < testCase.solid * 0.25;
  const ok = errored || hollow;
  if (!ok) failures += 1;
  const detail = errored
    ? `refused: ${report.error}`
    : `volume ${volume.toFixed(0)} mm3 of ${testCase.solid} solid, ${triangles} triangles`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name} → ${detail}`);
}

console.log(consoleErrors.length === 0 ? 'no page errors' : consoleErrors.slice(0, 3));
await browser.close();
if (failures > 0 || consoleErrors.length > 0) process.exitCode = 1;
