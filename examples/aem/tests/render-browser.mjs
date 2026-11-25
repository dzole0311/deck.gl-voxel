import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { createServer } from 'vite';

const server = await createServer({ root: 'examples/aem', server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  channel: process.env.VOXEL_BROWSER_CHANNEL ?? 'chrome',
  headless: true,
  args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
});
const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('404')) {
    errors.push(m.text());
  }
});
try {
  await page.goto(`${url}tests/render.html`);
  await page.waitForFunction(
    () => window.cellFixture?.deck.isInitialized && window.cellFixture.frames > 0,
  );
  async function render(options = {}) {
    await page.evaluate((options) => window.cellFixture.render(options), options);
    await page.waitForFunction(() => window.cellFixture.frames > 0);
    return PNG.sync.read(await page.screenshot());
  }
  function counts(png) {
    let red = 0,
      blue = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] > 100 && png.data[i + 1] < 30 && png.data[i + 2] < 30) {
        red++;
      }
      if (png.data[i + 2] > 100 && png.data[i] < 30 && png.data[i + 1] < 30) {
        blue++;
      }
    }
    return { red, blue };
  }
  const all = counts(await render());
  assert.ok(all.red > 100 && all.blue > 100, JSON.stringify(all));
  assert.equal(
    await page.evaluate(() => window.cellFixture.deck.props.layers[0].getModels()[0].instanceCount),
    4,
    'deck.gl must preserve the complete opaque instance count',
  );
  const red = counts(await render({ mask: 1 }));
  assert.ok(red.red > 100);
  assert.equal(red.blue, 0);
  const cut = counts(await render({ clip: [-3, -1, -2, 3, 1, -0.5] }));
  assert.ok(cut.red > 100);
  assert.equal(cut.blue, 0, 'physical clipping closes the exposed red surface');
  const hidden = counts(await render({ mask: 0 }));
  assert.equal(hidden.red + hidden.blue, 0);
  // Move the near plane through the boxes. A closed opaque cap must retain visible colored coverage.
  const cappedImage = await render({ camera: [-2, 0, -0.5], near: 1.05 });
  const capped = counts(cappedImage);
  assert.ok(capped.red + capped.blue > 100);
  const capSamples = await page.evaluate(() => {
    const samples = [];
    for (let y = 5; y < 395; y += 5) {
      for (let x = 5; x < 395; x += 5) {
        const [px, py, pz] = window.cellFixture.nearPoint(x + 0.5, y + 0.5);
        if (
          ((px > -2.98 && px < -1.02) || (px > 1.02 && px < 2.98)) &&
          Math.abs(py) < 0.98 &&
          pz > -1.98 &&
          pz < 1.98 &&
          Math.abs(pz) > 0.02
        ) {
          samples.push({ x, y, channel: pz < 0 ? 0 : 2 });
        }
      }
    }
    return samples;
  });
  assert.ok(capSamples.length > 100, 'The near plane must cut through a substantial cell interior');
  for (const { x, y, channel } of capSamples) {
    assert.ok(
      cappedImage.data[(y * cappedImage.width + x) * 4 + channel] >= 253,
      `The near-plane cap must show the unshaded category at ${x},${y}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    'Opaque WebGPU: all instances, exact palette, native gap, category filtering, physical cuts and near-plane caps passed.',
  );
} finally {
  await browser.close();
  await server.close();
}
