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
  let viewerModuleUrl;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/src/viewer.ts')) {
      viewerModuleUrl = request.url();
    }
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
  assert.equal(
    await page.getByRole('slider', { name: 'Density', exact: true }).getAttribute('aria-valuetext'),
    (await page.locator('#density-value').textContent()).trim(),
  );
  assert.equal(
    await page
      .getByRole('slider', { name: 'Exaggeration', exact: true })
      .getAttribute('aria-valuetext'),
    (await page.locator('#exaggeration-value').textContent()).trim(),
  );
  assert.ok(requests > 0, 'The example must read real generated Zarr chunks');
  assert.equal(await page.locator('#chunk-inspector').count(), 0);

  await page.waitForTimeout(300);
  const loadedRequests = requests;
  await page.getByRole('checkbox', { name: 'Chunk inspector', exact: true }).check();
  await page.locator('#debug-counters').waitFor();
  await page.waitForTimeout(300);
  assert.equal(requests, loadedRequests);
  const overview = page.locator('#chunk-overview');
  const captureOverview = () => overview.evaluate((canvas) => canvas.toDataURL());
  await page.evaluate(() => {
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    const stroke = CanvasRenderingContext2D.prototype.stroke;
    window.inspectorDrawing = { clears: 0, outlineAlpha: 0 };
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.id === 'chunk-overview' || this.canvas.id === 'chunk-outlines') {
        window.inspectorDrawing.clears++;
      }
      if (this.canvas.id === 'chunk-outlines') {
        window.inspectorDrawing.outlineAlpha = 0;
      }
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      if (this.canvas.id === 'chunk-outlines') {
        window.inspectorDrawing.outlineAlpha = Math.max(
          window.inspectorDrawing.outlineAlpha,
          this.globalAlpha,
        );
      }
      return stroke.apply(this, args);
    };
  });
  await page.waitForTimeout(350);
  assert.equal(
    await page.evaluate(() => window.inspectorDrawing.clears),
    0,
    'A settled inspector should not redraw while idle',
  );
  assert.equal(
    await page.getByRole('button', { name: '3D camera view' }).getAttribute('aria-pressed'),
    'true',
  );
  const perspectiveOverview = await captureOverview();
  await page.getByRole('button', { name: '2D camera view' }).click();
  await page.waitForTimeout(150);
  assert.notEqual(await captureOverview(), perspectiveOverview);
  await page.getByRole('button', { name: '3D camera view' }).click();
  await page.waitForTimeout(150);
  assert.equal(requests, loadedRequests, 'Changing overview mode must not fetch chunks');
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

  await page.getByLabel('Chunk', { exact: true }).selectOption('0,0,0,0');
  const time = page.getByRole('slider', { name: 'Time', exact: true });
  await time.focus();
  await time.press('ArrowRight');
  await idle();
  assert.equal(await time.getAttribute('aria-valuenow'), '1');
  await page.waitForFunction(() => document.querySelector('#debug-chunk')?.value === '');
  assert.equal(await page.locator('#debug-details').count(), 0);
  assert.ok(
    await page.evaluate(() => window.inspectorDrawing.outlineAlpha > 0.5),
    'A missing chunk selection must not dim the next frame',
  );
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#time')?.textContent?.includes('02:00'));
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await idle();
  const beforeZoom = requests;
  const controlsBeforeZoom = await page
    .getByRole('checkbox', { name: 'Outlines', exact: true })
    .boundingBox();
  const beforeZoomOverview = await captureOverview();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(600);
  await idle();
  assert.equal(requests, beforeZoom, 'Zooming into cached chunks should reuse them');
  assert.equal(
    (await page.getByRole('checkbox', { name: 'Outlines', exact: true }).boundingBox()).y,
    controlsBeforeZoom.y,
    'Reusing an assembled view must not shift the controls',
  );
  assert.notEqual(
    await captureOverview(),
    beforeZoomOverview,
    'The camera overview must follow the live view',
  );
  const countersBeforeStatus = await page.locator('#debug-counters').boundingBox();
  await page.getByRole('checkbox', { name: 'Freeze inspector', exact: true }).check();
  assert.equal(
    (await page.locator('#debug-counters').boundingBox()).y,
    countersBeforeStatus.y,
    'Selection status must not shift the controls',
  );
  const frozenCounters = await page.locator('#debug-counters').textContent();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.waitForTimeout(600);
  await idle();
  await page.getByText('Chunk selection frozen', { exact: true }).waitFor();
  assert.equal(await page.getByText('Updating chunk selection…', { exact: true }).count(), 0);
  assert.equal(await page.locator('#debug-counters').textContent(), frozenCounters);
  await page.getByRole('checkbox', { name: 'Freeze inspector', exact: true }).uncheck();
  await page.getByText('Chunk selection frozen', { exact: true }).waitFor({ state: 'hidden' });
  const beforeReload = requests;
  await page.getByRole('button', { name: 'Clear cache and reload' }).click();
  await page.waitForFunction(
    () => Number(document.querySelector('#chunk-inspector')?.getAttribute('data-selected')) > 0,
  );
  await idle();
  assert.ok(requests > beforeReload, 'Reload must fetch a fresh reader');
  await page.getByRole('checkbox', { name: 'Slow requests' }).check();
  await page.getByRole('button', { name: 'Clear cache and reload' }).click();
  await page.getByRole('checkbox', { name: 'Slow requests' }).uncheck();
  await idle();
  assert.equal((await page.locator('#status').textContent()).trim(), '');
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
  assert.equal(
    await page
      .getByRole('slider', { name: 'Isovalue', exact: true })
      .getAttribute('aria-valuetext'),
    (await page.locator('#isovalue-value').textContent()).trim(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await idle();
  const narrow = await page.locator('#chunk-inspector').boundingBox();
  assert.ok(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 390);
  assert.equal((await page.locator('#status').textContent()).trim(), '');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Close chunk inspector' }).click();
  assert.ok(viewerModuleUrl);
  await page.evaluate(async (moduleUrl) => {
    const { ExampleViewer } = await import(moduleUrl);
    const original = ExampleViewer.prototype.getReader;
    let opened = false;
    ExampleViewer.prototype.getReader = function () {
      const reader = original.call(this);
      return opened && reader
        ? Object.assign(Object.create(reader), { getDebugState: undefined })
        : undefined;
    };
    window.openCustomReader = () => {
      opened = true;
    };
    window.restoreReader = () => {
      ExampleViewer.prototype.getReader = original;
    };
  }, viewerModuleUrl);
  await page.getByRole('checkbox', { name: 'Chunk inspector', exact: true }).check();
  await page.getByText('Waiting for chunks', { exact: true }).waitFor();
  await page.evaluate(() => window.openCustomReader());
  await page.getByText('This reader does not expose chunk diagnostics', { exact: true }).waitFor();
  await page.evaluate(() => window.restoreReader());
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  touch.setDefaultTimeout(15000);
  await touch.route('**/*', async (route) => {
    if (route.request().resourceType() === 'document') {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text()).replace('id="root"', 'id="old-root"'),
      });
    } else if (route.request().url().startsWith('https://tiles.openfreemap.org/')) {
      await route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
    } else {
      await route.continue();
    }
  });
  await touch.goto(`${url}?dataset=chunks`);
  await touch.getByRole('heading', { name: 'Weather volumes' }).waitFor();
  assert.equal(
    await touch.locator('#root').count(),
    1,
    'Startup recovers from a missing mount element',
  );
  assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  for (const label of ['Dataset', 'Render mode']) {
    const bounds = await touch.getByLabel(label, { exact: true }).boundingBox();
    assert.ok(bounds && bounds.height >= 48, 'Touch selects should retain a 48px target');
  }
  await touch.close();
  assert.deepEqual(errors, []);
  console.log('MapLibre inspector, controls, cache reuse and playback passed');
} finally {
  await browser.close();
  await server.close();
}
