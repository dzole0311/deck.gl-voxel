import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createServer } from 'vite';

const output = process.env.AEM_ARTIFACTS ?? '/tmp/aem-validation';
await mkdir(output, { recursive: true });
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({
  channel: process.env.VOXEL_BROWSER_CHANNEL ?? 'chrome',
  headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const warnings = [];
const errors = [],
  failed = [],
  requests = [],
  report = { stages: [], profiles: [], sourceSamples: [] };
report.runtime = {
  browser: browser.version(),
  platform: process.platform,
  node: process.version,
  viewport: [1400, 1000],
  deviceScaleFactor: 1,
};
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) {
    errors.push(m.text());
  }
});
page.on('console', (message) => {
  if (message.type() === 'warning') {
    warnings.push(message.text());
  }
});
page.on('request', (r) => {
  if (r.url().includes('/aem.zarr/') && r.url().includes('/c/')) {
    requests.push({ url: r.url(), time: Date.now() });
  }
});
page.on('requestfailed', (r) => failed.push({ url: r.url(), error: r.failure()?.errorText }));
await page.addInitScript(() => {
  window.aemLongTasks = [];
  new PerformanceObserver((list) =>
    window.aemLongTasks.push(
      ...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
    ),
  ).observe({ type: 'longtask', buffered: true });
});
let shot = 0;
async function screenshot(name) {
  const file = path.join(output, `${String(shot++).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
async function settled() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  let stable = 0;
  for (let i = 0; i < 600; i++) {
    const state = await page.evaluate(() => window.aem?.source.getStats());
    if (state && !state.active && !state.queued) {
      stable++;
      if (stable >= 5) {
        return;
      }
    } else {
      stable = 0;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(
    `Source did not settle: ${JSON.stringify(await page.evaluate(() => window.aem?.source.getStats()))}`,
  );
}
async function view(patch) {
  await page.evaluate((patch) => {
    const v = window.aem.viewer;
    v.setView({ ...v.getView(), ...patch });
  }, patch);
}
async function snapshot(name) {
  const state = await page.evaluate(() => ({
    elapsedMs: performance.now(),
    view: window.aem.viewer.getView(),
    stats: window.aem.source.getStats(),
    tiles: window.aem.source.getTiles().length,
    instances: window.aem.source.getTiles().reduce((n, t) => n + t.mesh.count, 0),
    levels: window.aem.source.getTiles().reduce((a, t) => {
      a[t.level] = (a[t.level] ?? 0) + 1;
      return a;
    }, {}),
  }));
  report.stages.push({ name, ...state, screenshot: await screenshot(name) });
  console.log(
    name,
    JSON.stringify({
      tiles: state.tiles,
      instances: state.instances,
      levels: state.levels,
      active: state.stats.active,
      cpuMiB: (state.stats.cacheBytes + state.stats.meshBytes) / 1048576,
    }),
  );
  return state;
}
async function profile(name, steps = 150) {
  const result = await page.evaluate(async (steps) => {
    const { viewer, source } = window.aem,
      base = viewer.getView(),
      samples = [];
    const before = source.getStats();
    const modelsBefore = viewer.deck.layerManager
      .getLayers()
      .filter((l) => l.props.mesh)
      .map((l) => l.getCurrentLayer()?.state?.model);
    const gpu = () => {
      const manager = viewer.deck.device?.statsManager;
      return manager
        ? Object.fromEntries([...manager.stats].map(([name, stats]) => [name, stats.getTable()]))
        : undefined;
    };
    const gpuBefore = gpu();
    const gpuQueue = viewer.deck.device?.handle?.queue,
      gpuFences = [],
      gpuWaits = [];
    const start = performance.now();
    let previous = start;
    for (let i = 0; i < steps; i++) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      samples.push(now - previous);
      previous = now;
      if (gpuQueue) {
        const submitted = performance.now();
        gpuWaits.push(
          gpuQueue.onSubmittedWorkDone().then(() => gpuFences.push(performance.now() - submitted)),
        );
      }
      viewer.setView({
        ...base,
        bearing: (base.bearing ?? 0) + Math.sin(i / 20) * 2,
        longitude: base.longitude + Math.sin(i / 30) * 0.0002,
      });
    }
    await Promise.all(gpuWaits);
    gpuFences.sort((a, b) => a - b);
    samples.sort((a, b) => a - b);
    const after = source.getStats();
    const end = performance.now();
    return {
      frames: steps,
      gpuCompletionP95Ms: gpuFences[Math.floor(gpuFences.length * 0.95)],
      gpuCompletionMaxMs: gpuFences.at(-1),
      p50: samples[Math.floor(steps * 0.5)],
      p95: samples[Math.floor(steps * 0.95)],
      p99: samples[Math.floor(steps * 0.99)],
      max: samples.at(-1),
      longTasks: window.aemLongTasks.filter((e) => e.start >= start && e.start <= end),
      preparedDelta: after.prepared - before.prepared,
      gpuBefore,
      gpuAfter: gpu(),
      retainedModels: viewer.deck.layerManager
        .getLayers()
        .filter((l) => l.props.mesh)
        .filter((l) => modelsBefore.includes(l.getCurrentLayer()?.state?.model)).length,
      modelsBefore: modelsBefore.length,
      heap: performance.memory?.usedJSHeapSize,
      stats: after,
    };
  }, steps);
  report.profiles.push({ name, ...result });
  console.log(
    'profile',
    name,
    JSON.stringify({
      p50: result.p50,
      p95: result.p95,
      p99: result.p99,
      longTasks: result.longTasks.length,
      preparedDelta: result.preparedDelta,
      retainedModels: result.retainedModels,
      modelsBefore: result.modelsBefore,
    }),
  );
}

try {
  const start = Date.now();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.aem?.source, { timeout: 60000 });
  await screenshot('initial-loading');
  await settled();
  report.initialSettleMs = Date.now() - start;
  await snapshot('default');
  report.adapter = await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return {
      vendor: a.info.vendor,
      architecture: a.info.architecture,
      device: a.info.device,
      description: a.info.description,
    };
  });
  const defaultView = await page.evaluate(() => window.aem.viewer.getView());
  // Match the two camera stacks numerically at datum-plane landmarks after an underground focus shift.
  report.mapAlignment = await page.evaluate(() => {
    const { viewer } = window.aem,
      v = viewer.deck.getViewports()[0];
    return [
      [-119.55, 36.5],
      [-119.5, 36.6],
      [-119.7, 36.4],
    ].map((p) => {
      const a = v.project([...p, 0]),
        transform = viewer.map._camera.transform,
        coordinate = transform.worldCoordinateHelper.worldFromLngLat(p[0], p[1]),
        b = transform.coordinatePoint(coordinate, 0, transform._pixelMatrix3D);
      return Math.hypot(a[0] - b.x, a[1] - b.y);
    });
  });
  assert.ok(
    report.mapAlignment.every((error) => error < 0.05),
    `Map alignment ${report.mapAlignment}`,
  );
  // Compare several visibly colored pixels with reusable physical picking and preserve their global native indices.
  const png = PNG.sync.read(await page.screenshot());
  const points = [];
  for (let y = 200; y < 900 && points.length < 6; y += 90) {
    for (let x = 400; x < 1300 && points.length < 6; x += 130) {
      const i = (y * png.width + x) * 4;
      if (
        Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) -
          Math.min(png.data[i], png.data[i + 1], png.data[i + 2]) >
        70
      ) {
        points.push([x, y]);
      }
    }
  }
  report.sourceSamples = await page.evaluate(
    (points) =>
      points.flatMap(([x, y]) => {
        const picked = window.aem.viewer.pick(x, y);
        if (picked?.tile.level !== 0) {
          return [];
        }
        const { hit, tile } = picked,
          g = tile.mesh.grid;
        return [
          {
            path: tile.field.path,
            value: hit.value,
            index: [tile.x + hit.index[0], tile.y + hit.index[1], hit.index[2]],
            ground: hit.groundZ,
            physicalZ: hit.physicalZ,
            displayZ: hit.position[2],
            elevationScale: g.elevationScales[hit.index[1]],
            commonCenter: [
              g.origin[0] + (hit.index[0] + 0.5) * g.spacing[0],
              g.origin[1] + (hit.index[1] + 0.5) * g.spacing[1],
            ],
          },
        ];
      }),
    points,
  );
  assert.ok(report.sourceSamples.length >= 3, 'Visible native picks must exist');
  await profile('default-navigation');
  await view({ zoom: 8 });
  await settled();
  await snapshot('zoomed-out');
  await profile('broad-navigation', 120);
  for (let i = 0; i <= 18; i++) {
    await view({ zoom: 8 + i * 0.3 });
    await page.waitForTimeout(90);
    if (i % 3 === 0) {
      await snapshot(`zoom-frame-${i}`);
    }
  }
  await settled();
  await snapshot('close-settled');
  await profile('close-navigation');
  await view({ ...defaultView, zoom: 8.7 });
  await settled();
  const levelFrames = [];
  for (let i = 0; i < 12; i++) {
    await view({ zoom: 8.7 + (i % 2 ? 0.025 : -0.025) });
    await page.waitForTimeout(100);
    levelFrames.push(
      await page.evaluate(() =>
        Object.fromEntries(window.aem.source.getTiles().map((t) => [t.id, t.level])),
      ),
    );
    if (i < 4) {
      await screenshot(`transition-${i}`);
    }
  }
  const common = Object.keys(levelFrames[0]).filter((id) => levelFrames.every((f) => id in f));
  const changing = common.filter((id) => levelFrames.some((f) => f[id] !== levelFrames[0][id]));
  report.transition = { commonTiles: common.length, changingTiles: changing.length };
  console.log(
    'transition',
    changing.map((id) => ({ id, levels: levelFrames.map((f) => f[id]) })),
  );
  const toggling = common.filter(
    (id) => levelFrames.slice(1).filter((frame, i) => frame[id] !== levelFrames[i][id]).length > 1,
  );
  report.transition.togglingTiles = toggling.length;
  assert.equal(
    toggling.length,
    0,
    'Small zoom oscillations may cross a threshold once but must not toggle back',
  );
  await view({ ...defaultView });
  await settled();
  await snapshot('zoom-return');
  await page.evaluate(() => window.aem.viewer.setContextVisible(false));
  await page.waitForTimeout(100);
  const beforeAsia = PNG.sync.read(await page.screenshot());
  const readsBeforeAsia = requests.length;
  await view({ longitude: 110, latitude: 30, zoom: 7, pitch: 45 });
  await settled();
  await snapshot('asia');
  assert.equal(await page.evaluate(() => window.aem.source.getTiles().length), 0);
  report.asiaRequests = requests.length - readsBeforeAsia;
  assert.equal(report.asiaRequests, 0, 'No AEM chunks should be requested in Asia');
  await view({ ...defaultView });
  await settled();
  const afterAsia = PNG.sync.read(await page.screenshot());
  let changedPixels = 0,
    pixels = 0;
  for (let y = 0; y < 1000; y++) {
    for (let x = 300; x < 1400; x++) {
      pixels++;
      const i = (y * 1400 + x) * 4;
      if ([0, 1, 2].some((c) => Math.abs(beforeAsia.data[i + c] - afterAsia.data[i + c]) > 2)) {
        changedPixels++;
      }
    }
  }
  report.asiaReturnChangedFraction = changedPixels / pixels;
  assert.equal(
    report.asiaReturnChangedFraction,
    0,
    'The same camera must recover the identical displayed geometry after Asia',
  );
  await snapshot('asia-return');
  await page.evaluate(() => window.aem.viewer.setContextVisible(true));
  for (let step = 0; step <= 12; step++) {
    await view({
      ...defaultView,
      longitude: defaultView.longitude + ((-121.5 - defaultView.longitude) * step) / 12,
      latitude: 36.5 + (0.05 * step) / 12,
    });
    await page.waitForTimeout(100);
    if (step % 4 === 0) {
      await snapshot(`boundary-pan-${step}`);
    }
  }
  await settled();
  await snapshot('boundary-pan-settled');
  await view({ ...defaultView });
  await settled();
  for (const [name, patch] of [
    ['rotated-side', { pitch: 82, bearing: 90, zoom: 13 }],
    ['side', { pitch: 82, bearing: 40, zoom: 13 }],
    ['below', { pitch: 120, bearing: 40, zoom: 13 }],
    ['inside', { pitch: 80, zoom: 16, position: [0, 0, -2500] }],
    [
      'salinas',
      { longitude: -121.5, latitude: 36.55, zoom: 10.8, pitch: 62, position: [0, 0, -1300] },
    ],
    [
      'overlap',
      { longitude: -119.68, latitude: 37.04, zoom: 12, pitch: 65, position: [0, 0, -1300] },
    ],
  ]) {
    await view(patch);
    await settled();
    if (name === 'below' || name === 'inside') {
      assert.equal(await page.locator('#map').evaluate((el) => el.style.opacity), '0');
    }
    await snapshot(name);
  }
  await page.getByRole('button', { name: 'Chunk inspector', exact: true }).click();
  await page.waitForSelector('#chunk-inspector');
  const inspectorStart = performance.now();
  assert.ok(await page.locator('#debug-counters').textContent());
  await screenshot('inspector');
  report.inspectorCaptureMs = performance.now() - inspectorStart;
  await page.getByRole('button', { name: 'Close chunk inspector' }).click();
  // Context is independent of scalar resolution; published logs retain physical depths and their own ground elevations.
  await view({ ...defaultView });
  await settled();
  await page.getByRole('checkbox', { name: 'Flight paths', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Borehole lithology', exact: true }).click();
  await page.waitForFunction(
    () =>
      window.aem.viewer.deck.props.layers.some(
        (l) => l.id === 'aem-borehole-intervals' && l.props.data.length > 0,
      ),
    { timeout: 30000 },
  );
  await screenshot('survey-context');
  report.context = await page.evaluate(() =>
    window.aem.viewer.deck.layerManager
      .getLayers()
      .filter((l) => l.id.startsWith('aem-'))
      .map((l) => ({ id: l.id, segments: l.props.data.length, example: l.props.data[0] })),
  );
  await page.getByRole('checkbox', { name: 'Flight paths', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Borehole lithology', exact: true }).click();
  // Change survey and category controls while native refinement reads fail, then recover without a reload.
  await page.locator('#survey').selectOption('survey-area-2');
  await view({ longitude: -121.5, latitude: 41.85, zoom: 7, pitch: 55, position: [0, 0, 0] });
  await settled();
  await snapshot('sparse-overview');
  let faultCount = 0;
  const faultPattern = '**/coarse_fraction/survey-area-2-*/0/c/**';
  await page.route(faultPattern, async (route) => {
    faultCount++;
    if (faultCount <= 4) {
      await route.abort('failed');
    } else if (faultCount <= 10) {
      await route.fulfill({ status: 503, body: 'temporary test failure' });
    } else {
      await route.continue();
    }
  });
  await view({ zoom: 13 });
  await page.waitForTimeout(250);
  await screenshot('failure-retained-coverage');
  await page.getByRole('checkbox', { name: '0–10', exact: true }).click();
  await page.waitForTimeout(100);
  await page.getByRole('checkbox', { name: '0–10', exact: true }).click();
  await settled();
  await page.unroute(faultPattern);
  report.injectedFaults = Math.min(faultCount, 10);
  assert.ok(faultCount > 4);
  await snapshot('failure-recovered');
  // Cancel obsolete work by changing selection while reads are pending.
  await page.locator('#survey').selectOption('all');
  await view({ longitude: -121.6, latitude: 38.6, zoom: 10, pitch: 60 });
  await page.waitForTimeout(50);
  await page.locator('#survey').selectOption('survey-area-6');
  await page.locator('#survey').selectOption('all');
  await settled();
  await snapshot('selection-interruption-recovered');
  await view({ ...defaultView });
  await settled();
  await profile('return-navigation');
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  report.heap = await cdp.send('Runtime.getHeapUsage');
  report.dom = await cdp.send('Memory.getDOMCounters');
  report.failedRequests = failed;
  report.requests = requests.length;
  report.initialLongTasks = await page.evaluate(() => window.aemLongTasks);
  report.errors = errors;
  report.warnings = warnings;
  assert.deepEqual(
    warnings.filter((warning) => !/layers\[(?:highway-shield|road_shield)/.test(warning)),
    [],
  );
  assert.deepEqual(
    errors.filter((e) => !e.includes('503') && !e.includes('ERR_FAILED')),
    [],
    'No unexpected runtime or GPU validation errors',
  );
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log('AEM validation passed', output);
} finally {
  await browser.close();
  await server.close();
}
