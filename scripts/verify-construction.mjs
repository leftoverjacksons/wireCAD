/**
 * Checks construction lines: that one can be drawn, dimensioned and constrained
 * like any other line while the profile is built as though it were not there,
 * that the status can be turned on for what is drawn next and put on or taken
 * off a line already drawn, and that it survives a document being written out
 * and read back.
 *
 *   npm run dev
 *   npm run verify:construction
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

let failures = 0;
const check = (name, ok, extra) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} → ${extra}`);
};

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
});

console.log('a construction line in the profile path:');

// A rectangle with a diagonal across it, and the diagonal dimensioned. As an
// ordinary line it branches the loop at both corners; as a construction line it
// drives the shape without being part of it.
const built = await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });

  const constraints = [
    ['lockU', 0, 'originU'],
    ['lockV', 0, 'originV'],
    ['horizontal', 0],
    ['horizontal', 2],
    ['vertical', 1],
    ['vertical', 3],
    ['horizontalDistance', 0, 1, 'width'],
    ['distance', 0, 2, 'diagonal'],
  ];

  graph.addNode('sketch.constrained', {
    id: 'sk',
    label: 'Plate',
    inputs: {
      points: [0, 0, 60, 0, 60, 40, 0, 40],
      entities: [
        ['line', 0, 1],
        ['line', 1, 2],
        ['line', 2, 3],
        ['line', 3, 0],
        ['line', 0, 2, 1],
      ],
      constraints,
      dims: ['originU', 0, 'originV', 0, 'width', 60, 'diagonal', 100],
    },
  });
  graph.addNode('solid.extrude', { id: 'body', inputs: { distance: 10 } });
  graph.connect({ node: 'sk', port: 'profile' }, { node: 'body', port: 'profile' });
  await window.__settle();

  const read = (id) => {
    const mesh = window.wirecad.meshes().find((m) => m.nodeId === id);
    return {
      error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
      volume: mesh === undefined ? null : window.__volume(mesh),
    };
  };

  const dimensioned = read('body');
  const ports = graph
    .schemaOf('sk')
    .inputs.filter((p) => p.hidden !== true)
    .map((p) => p.label);

  // The same drawing with the diagonal made ordinary: now it is part of the
  // outline, and the outline branches.
  graph.setInput('sk', 'entities', [
    ['line', 0, 1],
    ['line', 1, 2],
    ['line', 2, 3],
    ['line', 3, 0],
    ['line', 0, 2],
  ]);
  await window.__settle();
  const asOutline = window.wirecad.reports().find((r) => r.nodeId === 'sk')?.error ?? null;

  return { dimensioned, ports, asOutline };
});

// 60 wide with a 100 diagonal is 80 high, which the diagonal is what decides.
check(
  'it drives what it measures',
  built.dimensioned.error === null && Math.abs(built.dimensioned.volume - 60 * 80 * 10) < 200,
  built.dimensioned.error ?? `${built.dimensioned.volume?.toFixed(0)} mm3, wanted ${60 * 80 * 10}`,
);
check(
  'its dimension is a port   ',
  built.ports.includes('diagonal'),
  built.ports.join(','),
);
check(
  'and as an outline it fails',
  built.asOutline !== null && /branch/.test(built.asOutline),
  built.asOutline ?? 'built a face out of a branching outline',
);

console.log('');
console.log('drawing one:');

await page.evaluate(async () => {
  const { graph } = window.wirecad;
  graph.restore({ version: 1, nodes: [], edges: [] });
  graph.addNode('plane.xy', { id: 'xy', label: 'XY Plane' });
  await window.__settle();
});

await page.getByRole('button', { name: 'Sketch', exact: true }).click();
await page.getByRole('button', { name: 'Create Sketch', exact: true }).click();
await page.locator('.feature-dialog select').first().selectOption({ label: 'XY Plane' });
await page.getByRole('button', { name: 'Create', exact: true }).click();

const panel = page.locator('.sketch-panel');
await panel.waitFor({ state: 'visible', timeout: 10_000 });

const canvas = await page.locator('canvas').first().boundingBox();
const at = (fx, fy) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy];

await panel.getByRole('button', { name: 'Rectangle', exact: true }).click();
await page.mouse.click(...at(0.36, 0.34));
await page.mouse.click(...at(0.64, 0.62));
await page.waitForTimeout(300);

const construction = panel.getByRole('button', { name: 'Construction', exact: true });
await construction.click();
await page.waitForTimeout(200);
check(
  'the toggle says it is on  ',
  (await page.evaluate(() => window.wirecad.sketch.drawsConstruction)) === true,
  await construction.getAttribute('class'),
);

// A diagonal corner to corner, drawn onto the corners already there.
const screenOf = (u, v) => page.evaluate(([u, v]) => window.wirecad.screenOfSketch(u, v), [u, v]);
const corners = await page.evaluate(() => window.wirecad.sketch.solvedPoints().map((p) => ({ ...p })));
await panel.getByRole('button', { name: 'Line', exact: true }).click();
for (const corner of [corners[0], corners[2]]) {
  const spot = await screenOf(corner.u, corner.v);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(200);
}
await page.keyboard.press('Enter');
await page.waitForTimeout(400);

const drawn = await page.evaluate(async () => {
  await window.__settle();
  const { graph } = window.wirecad;
  const node = graph.allNodes().find((n) => n.type === 'sketch.constrained');
  return {
    id: node?.id ?? null,
    entities: graph.inputValue(node.id, 'entities') ?? [],
    error: window.wirecad.reports().find((r) => r.nodeId === node.id)?.error ?? null,
    status: document.querySelector('.sketch-status')?.textContent ?? '',
  };
});

const diagonal = drawn.entities[4];
check(
  'the line drawn is one too ',
  drawn.entities.length === 5 && diagonal?.[0] === 'line' && diagonal?.[3] === 1,
  JSON.stringify(drawn.entities),
);
check(
  'the profile is unbothered ',
  drawn.error === null,
  drawn.error ?? `clean · ${drawn.status}`,
);

// Picked and toggled, it goes back to being part of the outline — and the
// outline it rejoins branches, which is the profile saying it is there.
const middle = await screenOf(
  (corners[0].u + corners[2].u) / 2,
  (corners[0].v + corners[2].v) / 2,
);
await panel.getByRole('button', { name: 'Select', exact: true }).click();
await page.mouse.click(middle.x, middle.y);
await page.waitForTimeout(250);
await construction.click();
await page.waitForTimeout(400);

const asOutline = await page.evaluate(async (id) => {
  await window.__settle();
  return {
    entities: window.wirecad.graph.inputValue(id, 'entities') ?? [],
    error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
  };
}, drawn.id);
check(
  'picked, it can be put back',
  asOutline.entities[4]?.length === 3 && asOutline.error !== null,
  `${JSON.stringify(asOutline.entities[4])} · ${asOutline.error ?? 'no complaint'}`,
);

await construction.click();
await page.waitForTimeout(400);
const madeAgain = await page.evaluate(async (id) => {
  await window.__settle();
  return {
    entities: window.wirecad.graph.inputValue(id, 'entities') ?? [],
    error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
    mode: window.wirecad.sketch.drawsConstruction,
  };
}, drawn.id);
check(
  'and made construction again',
  madeAgain.entities[4]?.[3] === 1 && madeAgain.error === null,
  `${JSON.stringify(madeAgain.entities[4])} · ${madeAgain.error ?? 'clean'}`,
);
check(
  'without changing the mode ',
  madeAgain.mode === true,
  `mode is ${madeAgain.mode ? 'on' : 'off'}`,
);

// Changing the status is one step, like any other change to the drawing.
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);
const undone = await page.evaluate(async (id) => {
  await window.__settle();
  return {
    entities: window.wirecad.graph.inputValue(id, 'entities') ?? [],
    open: document.querySelector('.sketch-panel')?.hidden === false,
  };
}, drawn.id);
check(
  'and one undo puts it back ',
  undone.entities[4]?.length === 3 && undone.open,
  `${JSON.stringify(undone.entities[4])} · session ${undone.open ? 'open' : 'closed'}`,
);
await page.keyboard.press('Control+y');
await page.waitForTimeout(600);

console.log('');
console.log('drawn in dashes:');

// A dash is given in pixels, like every other size on the drawing. Zooming has
// to draw them again or they quietly become millimetres, and a construction
// line at another zoom stops reading as one.
const dashesOn = async (entity) =>
  page.evaluate(
    (entity) => window.wirecad.sketch.drawnSegments().filter((s) => s.entity === entity).length,
    entity,
  );
const perMm = () =>
  page.evaluate(() => {
    const here = window.wirecad.screenOfSketch(0, 0);
    const away = window.wirecad.screenOfSketch(10, 0);
    return Math.hypot(away.x - here.x, away.y - here.y) / 10;
  });

const solidSegments = await dashesOn(0);
const dashedNear = await dashesOn(4);
const zoomNear = await perMm();
check(
  'an outline edge is one line',
  solidSegments === 1,
  `${solidSegments} segment${solidSegments === 1 ? '' : 's'}`,
);
check(
  'a construction line is many',
  dashedNear > 3,
  `${dashedNear} dashes`,
);

await page.mouse.move(800, 300);
for (let step = 0; step < 6; step++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(500);
const dashedFar = await dashesOn(4);
const zoomFar = await perMm();

// Twice the zoom is twice as many dashes of the same size on screen, give or
// take the one the pattern gains or loses fitting the line exactly.
const wanted = (dashedNear * zoomFar) / zoomNear;
check(
  'zooming redraws them       ',
  Math.abs(dashedFar - wanted) <= 1.5,
  `${dashedNear} dashes at ${zoomNear.toFixed(2)} px/mm → ${dashedFar} at ${zoomFar.toFixed(2)}, wanted about ${wanted.toFixed(1)}`,
);

console.log('');
console.log('written out and read back:');

await panel.getByRole('button', { name: 'Finish', exact: true }).click();
await panel.waitFor({ state: 'hidden', timeout: 10_000 });

const restored = await page.evaluate(async (id) => {
  const { graph } = window.wirecad;
  const saved = JSON.stringify(graph.toJSON());
  graph.restore(JSON.parse(saved));
  await window.__settle();
  return {
    entities: graph.inputValue(id, 'entities') ?? [],
    error: window.wirecad.reports().find((r) => r.nodeId === id)?.error ?? null,
  };
}, drawn.id);
check(
  'the status is kept        ',
  restored.entities[4]?.[3] === 1 && restored.error === null,
  `${JSON.stringify(restored.entities[4])} · ${restored.error ?? 'clean'}`,
);

if (pageErrors.length > 0) {
  failures += pageErrors.length;
  console.log('');
  for (const error of pageErrors) console.log(`page error: ${error}`);
} else {
  console.log('');
  console.log('no page errors');
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
