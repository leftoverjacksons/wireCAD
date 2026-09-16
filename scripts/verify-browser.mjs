/**
 * Drives the running dev server in a real browser and reports what the solver
 * did. The OpenCASCADE kernel cannot run under Node (its Emscripten glue calls
 * require() from an ES module), so the geometry path is only verifiable here.
 *
 *   npm run dev
 *   npm run verify:browser
 *
 * CHROMIUM_PATH overrides the browser binary when the bundled one is absent.
 */
import { chromium } from 'playwright';

const url = process.env.WIRECAD_URL ?? 'http://localhost:5173/';
const executablePath = process.env.CHROMIUM_PATH;

const browser = await chromium.launch({
  ...(executablePath === undefined ? {} : { executablePath }),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
page.on('pageerror', (error) => errors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page
  .locator('#kernel-status')
  .filter({ hasText: 'kernel ready' })
  .waitFor({ timeout: 180_000 });

console.log(await page.locator('#kernel-status').innerText());

await page.locator('#reports tr').first().waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);
console.log('cold solve  :', await page.locator('#stats').innerText());

const sliders = page.locator('input[type=range]');
const count = await sliders.count();

for (let index = 0; index < count; index++) {
  const slider = sliders.nth(index);
  await slider.focus();
  for (let press = 0; press < 5; press++) await slider.press('ArrowRight');
  await page.waitForTimeout(2000);
  const label = await page
    .locator('.label-row span')
    .nth(index * 2)
    .innerText();
  console.log(`after ${label.padEnd(12)}:`, await page.locator('#stats').innerText());
}

const rendered = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return canvas === null ? null : { width: canvas.width, height: canvas.height };
});
console.log('canvas      :', rendered ?? 'MISSING');
console.log('console     :', errors.length === 0 ? 'no errors' : errors.slice(0, 5));

await browser.close();
if (errors.length > 0 || rendered === null) process.exitCode = 1;
