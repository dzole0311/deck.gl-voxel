import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium
  .launch({
    channel: process.env.VOXEL_BROWSER_CHANNEL ?? 'chrome',
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  let requests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/chunk-demo.zarr/c/')) {
      requests++;
    }
  });
  await page.route('https://tiles.openfreemap.org/**', (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eee' } }],
      },
    }),
  );
  const url = server.resolvedUrls?.local[0];
  assert.ok(url);
  await page.goto(`${url}?dataset=chunks`);
  const idle = () =>
    page.waitForFunction(() => document.querySelector('#controls')?.dataset.state === 'ready');
  await idle();
  assert.ok(requests > 0, 'The example must read real generated Zarr chunks');
  assert.equal(await page.locator('#chunk-inspector').count(), 0);

  // Inspecting an already loaded source must not reopen it or fetch data.
  await page.waitForTimeout(300);
  const loadedRequests = requests;
  await page.getByRole('checkbox', { name: 'Chunk inspector', exact: true }).check();
  await page.locator('#debug-counters').waitFor();
  await page.waitForTimeout(300);
  assert.equal(requests, loadedRequests);
  const panel = await page.locator('#chunk-inspector').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    x: element.getBoundingClientRect().x,
    right: element.getBoundingClientRect().right,
    top: element.getBoundingClientRect().top,
  }));
  assert.ok(['rgb(255, 255, 255)', 'oklch(1 0 0)'].includes(panel.background));
  assert.equal(panel.right, 1424);
  assert.equal(panel.top, 16);
  assert.ok(panel.x > 1000);
  await page.getByLabel('Chunk', { exact: true }).selectOption('0,0,0,0');
  await page.locator('#debug-details').waitFor();
  await page.getByRole('checkbox', { name: 'Outlines', exact: true }).uncheck();
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('#chunk-outlines').evaluate((canvas) => {
      const context = canvas.getContext('2d');
      return context
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value) => value !== 0);
    }),
    false,
  );
  await page.getByRole('checkbox', { name: 'Outlines', exact: true }).check();
  await page.getByRole('button', { name: 'Close chunk inspector' }).click();
  assert.equal(await page.locator('#chunk-outlines').count(), 0);
  await page.waitForFunction(() => document.activeElement?.id === 'show-inspector');
  await page.getByRole('checkbox', { name: 'Chunk inspector', exact: true }).check();
  await page.locator('#debug-counters').waitFor();
  assert.equal(requests, loadedRequests);

  const time = page.getByRole('slider', { name: 'Time', exact: true });
  await time.focus();
  await time.press('ArrowRight');
  await idle();
  assert.equal(await time.getAttribute('aria-valuenow'), '1');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#time')?.textContent?.includes('02:00'));
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await idle();
  const beforeZoom = requests;
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(600);
  await idle();
  assert.equal(requests, beforeZoom, 'Zooming into cached chunks should reuse them');
  const beforeReload = requests;
  await page.getByRole('button', { name: 'Clear cache and reload' }).click();
  await page.waitForFunction(
    () => Number(document.querySelector('#chunk-inspector')?.getAttribute('data-selected')) > 0,
  );
  await idle();
  assert.ok(requests > beforeReload, 'Reload must fetch a fresh reader');
  await time.press('Home');
  await idle();
  const track = await page.locator('#hour').boundingBox();
  assert.ok(track);
  await page.mouse.move(track.x + 8, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width - 8, track.y + track.height / 2, { steps: 8 });
  await page.mouse.up();
  await idle();
  assert.equal(await time.getAttribute('aria-valuenow'), '3');
  await time.press('ArrowLeft');
  await idle();
  assert.equal(await time.getAttribute('aria-valuenow'), '2');
  await page.getByLabel('Render mode', { exact: true }).selectOption('isosurface');
  await page.getByRole('slider', { name: 'Isovalue', exact: true }).press('ArrowRight');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const narrow = await page.locator('#chunk-inspector').boundingBox();
  assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 390);
  assert.deepEqual(errors, []);
  console.log('MapLibre inspector, controls, cache reuse and playback passed');
} finally {
  await browser.close();
  await server.close();
}
