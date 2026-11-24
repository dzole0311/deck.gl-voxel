import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createServer } from 'vite';

const server = await createServer({
  root: 'tests/fixtures',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();

const url = server.resolvedUrls?.local[0];

assert.ok(url, 'Vite must expose a local URL');

const browser = await chromium
  .launch({
    channel: process.env.VOXEL_BROWSER_CHANNEL ?? 'chrome',
    headless: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });

const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const errors = [];

page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  // Zarrita probes absent v2 metadata while discovering the v3 fixture hierarchy.
  if (
    message.location().url.includes('/zarr-layer-fixture/') &&
    message.text().includes('status of 404')
  ) {
    return;
  }
  if (message.type() === 'error' || message.type() === 'warning') {
    errors.push(message.text());
  }
});

/**
 * Draws a test scene on the layer's WebGPU device and takes a screenshot.
 *
 * @param {object} options - Fixture, sampling, clipping, placement, and camera overrides.
 * @returns {Promise<PNG>} Screenshot pixels after a completed deck.gl frame.
 */
async function render(options = {}) {
  await page.evaluate((options) => {
    const app = window.voxelFixture;
    const { deck, VoxelLayer, OrbitView, MapView, ObstacleLayer, depth } = app;
    const dimensions = [16, 12, 8];
    let volume = {
      values: new Float32Array(16 * 12 * 8).fill(0.5),
      dimensions,
      origin: [-16, -12, -8],
      spacing: [2, 2, 2],
    };

    if (options.ramp) {
      for (let z = 0; z < 8; z++) {
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 16; x++) {
            const missing = (options.missingY && y >= 4 && y <= 7) || (options.missingX && x >= 8);

            volume.values[x + 16 * (y + 12 * z)] = missing ? Number.NaN : y / 11;
          }
        }
      }
    }

    if (options.missing) {
      volume.values.fill(Number.NaN);
    }

    if (options.fixture) {
      volume = app.createFixture(options.fixture);
    }

    if (options.reverseX) {
      volume = { ...volume, origin: [24, -20, -18], spacing: [-1, 1.25, 1.5] };
    }

    if (options.reuse && app.lastLayer) {
      volume = app.lastLayer.props.volume;
    }

    if (options.sentinelSlab) {
      volume.noDataValue = -9999;

      for (let z = 0; z < 8; z++) {
        for (let y = 0; y < 12; y++) {
          for (let x = 7; x < 9; x++) {
            volume.values[x + 16 * (y + 12 * z)] = -9999;
          }
        }
      }
    }

    const previous = app.lastLayer?.state.resources;
    const transferFunction = options.gradient
      ? new Uint8Array([255, 0, 0, 16, 0, 0, 255, 16])
      : options.axisLut
        ? app.createLut('axes')
        : options.blue
          ? new Uint8Array([0, 0, 255, 16, 0, 0, 255, 16])
          : new Uint8Array([255, 0, 0, 16, 255, 0, 0, 16]);

    const layer = new VoxelLayer({
      id: 'test-volume',
      volume,
      renderMode: options.renderMode ?? 'volume',
      isovalue: options.isovalue ?? 0.5,
      transferFunction,
      colorBy: options.colorBy ?? 'value',
      stepSize: options.step ?? 0.5,
      maxSteps: options.maxSteps ?? 2048,
      clipBounds: options.clip ?? [0, 0, 0, 1, 1, 1],
      sampling: options.sampling ?? 'linear',
      density: options.density ?? 1,
      opacityUnitDistance: options.opacityUnitDistance,
      modelMatrix: options.modelMatrix,
      coordinateSystem: options.map ? 'meter-offsets' : 'cartesian',
      coordinateOrigin: options.map ? [-122.4, 37.78, 0] : [0, 0, 0],
      depthSource: options.depth === false ? undefined : depth,
    });

    app.lastLayer = layer;
    app.previousResources = previous;
    app.frames = 0;
    deck.setProps({
      controller: false,
      views: options.map
        ? new MapView({ farZMultiplier: options.farZMultiplier ?? 1.01 })
        : new OrbitView({
            far: options.orthographic === false ? 1000 : 1.5,
            orbitAxis: 'Z',
            orthographic: options.orthographic ?? true,
          }),
      viewState: options.map
        ? (options.viewState ?? {
            longitude: -122.4,
            latitude: 37.78,
            zoom: 18,
            pitch: 35,
            bearing: 0,
          })
        : (options.viewState ?? {
            target: [0, 0, 0],
            rotationX: 0,
            rotationOrbit: 0,
            zoom: 2.5,
          }),
      layers: options.obstacle ? [new ObstacleLayer({ id: 'obstacle' }), layer] : [layer],
      onAfterRender: () => {
        app.frames++;
      },
    });
  }, options);

  await page.waitForFunction(() => window.voxelFixture.frames > 0);

  return PNG.sync.read(await page.screenshot());
}

/**
 * Reads a pixel from a screenshot taken at one device pixel per CSS pixel.
 *
 * @param {PNG} image - Captured screenshot.
 * @param {number} x - Horizontal pixel coordinate.
 * @param {number} y - Vertical pixel coordinate.
 * @returns {number[]} Red, green, blue, and alpha bytes.
 */
function pixel(image, x = 200, y = 200) {
  const index = (Math.round(y) * image.width + Math.round(x)) * 4;

  return [...image.data.subarray(index, index + 4)];
}

try {
  await page.goto(url);
  await page.waitForFunction(() => window.voxelFixture?.deck.isInitialized);
  const gpu = await page.evaluate(() => window.voxelFixture.deck.device.type);
  assert.equal(gpu, 'webgpu', 'must exercise WebGPU, not a WebGL fallback');

  const full = pixel(await render());
  assert.ok(full[0] > 70 && full[1] < 4 && full[2] < 4, `transfer function: ${full}`);
  const coarse = pixel(await render({ step: 2 }));
  assert.ok(Math.abs(full[0] - coarse[0]) <= 2, 'opacity stays stable when sample step changes');

  const bounded = pixel(await render({ maxSteps: 2 }));
  assert.ok(
    Math.abs(full[0] - bounded[0]) <= 2,
    'maximum iterations coarsens sampling without truncating the ray',
  );

  const topDown = {
    map: true,
    // Include the stretched grid below ground instead of clipping it at the map far plane.
    farZMultiplier: 4,
    viewState: { longitude: -122.4, latitude: 37.78, zoom: 18, pitch: 0, bearing: 0 },
  };
  const originalThickness = pixel(await render(topDown));
  const stretchedThickness = pixel(
    await render({
      ...topDown,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    }),
  );
  const expectedStretched = 255 * (1 - (1 - 16 / 255) ** 32);
  assert.ok(
    Math.abs(stretchedThickness[0] - expectedStretched) <= 3,
    `four times the transformed thickness must accumulate four times the optical depth: ${stretchedThickness}`,
  );
  assert.ok(stretchedThickness[0] > originalThickness[0] + 90);
  const stretchedCoarse = pixel(
    await render({
      ...topDown,
      step: 2,
      maxSteps: 2,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    }),
  );
  assert.ok(Math.abs(stretchedThickness[0] - stretchedCoarse[0]) <= 2);
  const reflectedThickness = pixel(
    await render({
      ...topDown,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -4, 0, 0, 0, 0, 1],
    }),
  );
  assert.ok(Math.abs(stretchedThickness[0] - reflectedThickness[0]) <= 2);

  const rigidTransform = pixel(
    await render({
      ...topDown,
      modelMatrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1],
    }),
  );
  assert.ok(
    Math.abs(originalThickness[0] - rigidTransform[0]) <= 2,
    'translation and rigid rotation must not change absorption',
  );
  const rescaledReference = pixel(
    await render({
      ...topDown,
      opacityUnitDistance: 8,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    }),
  );
  assert.ok(
    Math.abs(originalThickness[0] - rescaledReference[0]) <= 2,
    'scaling thickness and reference distance equally must preserve optical depth',
  );

  const transformedZoom = pixel(
    await render({
      ...topDown,
      viewState: { ...topDown.viewState, zoom: 18.5 },
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1],
    }),
  );
  assert.ok(
    Math.abs(stretchedThickness[0] - transformedZoom[0]) <= 2,
    'camera zoom must not change the reference opacity distance',
  );
  const shearedThickness = pixel(
    await render({
      ...topDown,
      modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 4, 0, 0, 0, 0, 1],
    }),
  );
  assert.ok(
    Math.abs(stretchedThickness[0] - shearedThickness[0]) <= 2,
    'sheared models must measure distance along the transformed ray',
  );

  const heightColors = await render({ gradient: true, colorBy: 'z' });
  const heightMarkers = await page.evaluate(() => {
    const viewport = window.voxelFixture.deck.getViewports()[0];

    return [
      [0, 0, -4],
      [0, 0, 4],
    ].map((point) => viewport.project(point));
  });
  const [lower, upper] = heightMarkers.map(([x, y]) => pixel(heightColors, x, y));

  assert.ok(lower[0] > lower[2] && upper[2] > upper[0], 'axis coloring follows grid Z');
  assert.ok(Math.abs(lower[0] + lower[2] - full[0]) < 4, 'axis coloring preserves scalar opacity');
  assert.deepEqual(
    pixel(await render({ missing: true })),
    [0, 0, 0, 255],
    'missing samples contribute no color',
  );

  assert.deepEqual(
    pixel(await render({ density: 0 })),
    [0, 0, 0, 255],
    'zero density is transparent',
  );

  assert.deepEqual(
    pixel(await render({ sentinelSlab: true, sampling: 'nearest' })),
    [0, 0, 0, 255],
    'an explicit missing-value slab stays empty under nearest sampling',
  );

  assert.deepEqual(
    pixel(await render({ clip: [0, 0, 0, 0, 1, 1] })),
    [0, 0, 0, 255],
    'zero-width clipping removes volume',
  );
  const half = pixel(await render({ clip: [0, 0, 0, 1, 0.5, 1] }));
  assert.ok(half[0] < full[0] - 15 && half[0] > 10, 'clipping shortens the optical path');

  const noDepth = pixel(await render({ obstacle: true, depth: false }));
  const withDepth = pixel(await render({ obstacle: true }));
  assert.ok(
    withDepth[1] > noDepth[1] + 15,
    `opaque plane removes samples behind it: ${noDepth} vs ${withDepth}`,
  );

  const surface = pixel(await render({ ramp: true, renderMode: 'isosurface', density: 0 }));

  assert.ok(
    surface[0] > 200 && surface[1] < 4,
    'a shaded scalar crossing renders an opaque surface',
  );
  assert.deepEqual(
    pixel(await render({ renderMode: 'isosurface', isovalue: 0.25 })),
    [0, 0, 0, 255],
    'a constant field does not acquire a surface on the domain boundary',
  );
  assert.deepEqual(
    pixel(await render({ ramp: true, renderMode: 'isosurface', isovalue: 1.1 })),
    [0, 0, 0, 255],
    'an out-of-range level produces no surface',
  );
  assert.deepEqual(
    pixel(await render({ ramp: true, renderMode: 'isosurface', missingY: true })),
    [0, 0, 0, 255],
    'missing samples cannot bridge a level crossing',
  );
  const maskedSurface = await render({ ramp: true, renderMode: 'isosurface', missingX: true });

  assert.ok(pixel(maskedSurface, 180)[0] > 200, 'the valid interior retains its isosurface');
  assert.deepEqual(
    pixel(maskedSurface),
    [0, 0, 0, 255],
    'a partially supported sample at the mask edge does not create a surface',
  );
  assert.ok(
    pixel(await render({ ramp: true, missingX: true }))[0] > 0,
    'volume mode still interpolates partially supported samples',
  );
  assert.deepEqual(
    pixel(await render({ ramp: true, renderMode: 'isosurface', clip: [0, 0, 0, 1, 0.4, 1] })),
    [0, 0, 0, 255],
    'clipping removes the level crossing without adding a cap',
  );

  const lowSurface = pixel(
    await render({ ramp: true, renderMode: 'isosurface', isovalue: 0.25, gradient: true }),
  );
  const highSurface = pixel(
    await render({ ramp: true, renderMode: 'isosurface', isovalue: 0.75, gradient: true }),
  );

  assert.ok(
    lowSurface[0] > lowSurface[2] && highSurface[2] > highSurface[0],
    'isosurface RGB uses the requested scalar level',
  );

  const behindLevel = await page.evaluate(() =>
    window.voxelFixture.deck.getViewports()[0].cameraPosition[1] < 0 ? 0.8 : 0.2,
  );
  const unoccludedSurface = pixel(
    await render({
      ramp: true,
      renderMode: 'isosurface',
      isovalue: behindLevel,
      obstacle: true,
      depth: false,
    }),
  );
  const occludedSurface = pixel(
    await render({ ramp: true, renderMode: 'isosurface', isovalue: behindLevel, obstacle: true }),
  );

  assert.ok(
    unoccludedSurface[1] < 4 && occludedSurface[1] > 50,
    'opaque scene depth clips isosurface hits',
  );

  const axes = await render({
    fixture: 'axes',
    axisLut: true,
    viewState: { target: [0, 0, 0], rotationX: 30, rotationOrbit: -35, zoom: 2.1 },
  });
  const markers = await page.evaluate(() => {
    const viewport = window.voxelFixture.deck.getViewports()[0];
    return [
      [18, -15, -13.5],
      [-18, 15, -13.5],
      [-18, -15, 13.5],
    ].map((p) => viewport.project(p));
  });
  const colors = markers.map(([x, y]) => pixel(axes, x, y));
  assert.ok(colors[0][0] > 200 && colors[0][1] < 80, `X is red: ${colors}`);
  assert.ok(colors[1][1] > 200 && colors[1][0] < 80, `Y is green: ${colors}`);
  assert.ok(colors[2][2] > 200 && colors[2][0] < 80, `Z is blue: ${colors}`);
  const flipped = await render({
    fixture: 'axes',
    axisLut: true,
    reverseX: true,
    viewState: { target: [0, 0, 0], rotationX: 30, rotationOrbit: -35, zoom: 2.1 },
  });
  const flippedMarker = await page.evaluate(() =>
    window.voxelFixture.deck.getViewports()[0].project([-18, -15, -13.5]),
  );
  const flippedColor = pixel(flipped, flippedMarker[0], flippedMarker[1]);

  assert.ok(
    flippedColor[0] > 200 && flippedColor[1] < 80,
    'negative X spacing mirrors the X marker',
  );

  await render();

  const blue = pixel(await render({ reuse: true, blue: true, step: 0.25 }));
  assert.equal(
    await page.evaluate(
      () =>
        window.voxelFixture.previousResources.volume ===
        window.voxelFixture.lastLayer.state.resources.volume,
    ),
    true,
    'style changes reuse scalar texture',
  );
  assert.ok(blue[2] > blue[0], 'replacing the transfer table changes rendered colors');

  await render();
  assert.equal(
    await page.evaluate(() => {
      const old = window.voxelFixture.previousResources;
      return (
        old.volume.destroyed &&
        old.transfer.destroyed &&
        old.uniforms.destroyed &&
        old.model._destroyed
      );
    }),
    true,
    'data replacement destroys previous GPU resources',
  );

  await page.route('**/zarr-layer-fixture/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/grid/zarr.json')) {
      await route.fulfill({
        json: {
          zarr_format: 3,
          node_type: 'array',
          shape: [2, 8, 12, 16],
          data_type: 'float32',
          chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 8, 12, 16] } },
          chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          fill_value: 0,
          attributes: {},
        },
      });
    } else if (path.includes('/c/')) {
      await route.fulfill({ body: Buffer.from(new Float32Array(16 * 12 * 8).fill(0.5).buffer) });
    } else {
      await route.fulfill({ status: 404 });
    }
  });
  const direct = pixel(await render());
  await page.evaluate(() => {
    const app = window.voxelFixture;
    const style = app.lastLayer.props;
    Object.assign(app, { loadedFrames: 0, sourceLoads: 0 });
    const layer = new app.ZarrVoxelLayer({
      ...style,
      id: 'url-volume',
      loadOptions: { core: { fetch: { headers: { 'X-Fixture': 'voxel' } } } },
      source: new URL('/zarr-layer-fixture', location.href).href,
      sourceOptions: {
        field: 'grid',
        layout: { axes: ['time', 'z', 'y', 'x'], origin: [-16, -12, -8], spacing: [2, 2, 2] },
      },
      onSourceLoad: () => {
        app.sourceLoads++;
      },
      onVolumeLoad: () => {
        app.loadedFrames++;
      },
    });
    app.deck.setProps({ layers: [layer] });
  });
  await page.waitForFunction(() => {
    const app = window.voxelFixture;
    return app.loadedFrames === 1 && app.deck.props.layers[0].isLoaded;
  });
  const loaded = pixel(PNG.sync.read(await page.screenshot()));
  assert.ok(
    loaded.every((value, index) => Math.abs(value - direct[index]) <= 2),
    'URL-backed layer renders the same frame and style as VoxelLayer',
  );
  await page.evaluate(() => {
    const app = window.voxelFixture;
    app.deck.setProps({
      layers: [
        app.deck.props.layers[0].clone({
          frameIndex: 1,
          density: 2,
          sourceOptions: structuredClone(app.deck.props.layers[0].props.sourceOptions),
          loadOptions: { core: { fetch: { headers: { 'X-Fixture': 'voxel' } } } },
        }),
      ],
    });
  });
  await page.waitForFunction(
    () =>
      window.voxelFixture.loadedFrames === 2 && window.voxelFixture.deck.props.layers[0].isLoaded,
  );
  assert.equal(
    await page.evaluate(() => window.voxelFixture.sourceLoads),
    1,
    'frame updates reuse opened metadata through deck.gl state transfer',
  );
  await page.unroute('**/zarr-layer-fixture/**');

  const perspective = pixel(await render({ orthographic: false }));
  assert.ok(perspective[0] > 70, 'perspective camera renders the volume');

  const inside = pixel(
    await render({
      orthographic: false,
      viewState: { target: [0, 0, 0], rotationX: 0, rotationOrbit: 0, zoom: 6 },
    }),
  );
  assert.ok(inside[0] > 10, 'camera inside the grid still integrates the forward ray');

  const mapped = pixel(await render({ map: true }));
  assert.ok(mapped[0] > 20, 'meter-offset volume renders at a geographic origin in MapView');

  await page.setViewportSize({ width: 480, height: 320 });
  await render({ obstacle: true });
  assert.equal(
    await page.evaluate(
      () =>
        window.voxelFixture.depth.getDepthTexture(window.voxelFixture.deck.getViewports()[0].id)
          .width,
    ),
    480,
    'depth capture resizes with canvas',
  );
  await page.evaluate(() => {
    const app = window.voxelFixture;
    app.lastResources = app.lastLayer.state.resources;
    app.deck.finalize();
  });
  assert.equal(
    await page.evaluate(() => {
      const r = window.voxelFixture.lastResources;
      return (
        r.volume.destroyed &&
        r.transfer.destroyed &&
        r.emptyDepth.destroyed &&
        r.uniforms.destroyed &&
        r.model._destroyed
      );
    }),
    true,
    'finalizing deck releases owned resources',
  );
  assert.deepEqual(await page.evaluate(() => window.voxelFixture.errors), []);
  assert.deepEqual(errors, [], 'no browser or GPU validation errors');
  console.log(
    'WebGPU browser checks passed: transfer function, step correction, clipping, missing data, axes, depth, resize, and resource disposal.',
  );
} finally {
  await browser.close();
  await server.close();
}
