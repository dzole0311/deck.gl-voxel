import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = process.env.AEM_ARTIFACTS ?? '/tmp/aem-validation';
const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
const url = 'https://d3d0qchq1igql3.cloudfront.net/aem/dwr-2026-11-23-v4/aem.zarr/';
const response = await fetch(new URL('zarr.json', url));
assert.ok(response.ok);
const metadata = (await response.json()).consolidated_metadata.metadata;
const bytesCache = new Map();
async function bytes(key, start, length) {
  const cacheKey = `${key}:${start}:${length}`;
  if (bytesCache.has(cacheKey)) {
    return bytesCache.get(cacheKey);
  }
  const headers = start === undefined ? {} : { Range: `bytes=${start}-${start + length - 1}` };
  const response = await fetch(new URL(key, url), { headers });
  if (response.status === 404) {
    return undefined;
  }
  assert.ok(response.ok, `${key}: ${response.status}`);
  let result = new Uint8Array(await response.arrayBuffer());
  if (start !== undefined && response.status === 200) {
    result = result.slice(start, start + length);
  }
  bytesCache.set(cacheKey, result);
  return result;
}
function crc32c(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return ~crc >>> 0;
}
const decoded = new Map();
async function decodedChunk(arrayPath, coords) {
  const m = metadata[arrayPath],
    shard = m.codecs.find((c) => c.name === 'sharding_indexed');
  const inner = shard?.configuration.chunk_shape ?? m.chunk_grid.configuration.chunk_shape;
  const outer = m.chunk_grid.configuration.chunk_shape;
  const outerCoord = coords.map((v, i) => Math.floor(v / outer[i]));
  const key = `${arrayPath}/c/${outerCoord.join('/')}`;
  let compressed;
  if (shard) {
    const indexShape = outer.map((v, i) => v / inner[i]);
    const size = indexShape.reduce((a, b) => a * b, 1) * 16 + 4;
    const index = await bytes(key, 0, size);
    if (!index) {
      return { data: undefined, shape: inner };
    }
    assert.equal(
      crc32c(index.subarray(0, size - 4)),
      new DataView(index.buffer, index.byteOffset + size - 4, 4).getUint32(0, true),
      'Shard-index CRC32C',
    );
    const position = coords
      .map((v, i) => Math.floor(v / inner[i]) % indexShape[i])
      .reduce((n, v, i) => n * indexShape[i] + v, 0);
    const view = new DataView(index.buffer, index.byteOffset + position * 16, 16);
    const offset = view.getBigUint64(0, true),
      length = view.getBigUint64(8, true);
    if (offset === 0xffffffffffffffffn) {
      return { data: undefined, shape: inner };
    }
    const cacheKey = `${key}:${offset}`;
    if (decoded.has(cacheKey)) {
      return { data: decoded.get(cacheKey), shape: inner };
    }
    compressed = await bytes(key, Number(offset), Number(length));
    assert.ok(compressed);
    const data = gunzipSync(compressed);
    decoded.set(cacheKey, data);
    return { data, shape: inner };
  }
  if (decoded.has(key)) {
    return { data: decoded.get(key), shape: inner };
  }
  compressed = await bytes(key);
  if (!compressed) {
    return { data: undefined, shape: inner };
  }
  const data = m.codecs.some((c) => c.name === 'gzip') ? gunzipSync(compressed) : compressed;
  decoded.set(key, data);
  return { data, shape: inner };
}
async function cell(arrayPath, coords) {
  const m = metadata[arrayPath];
  if (coords.some((v, i) => v < 0 || v >= m.shape[i])) {
    return NaN;
  }
  const { data, shape } = await decodedChunk(arrayPath, coords);
  if (!data) {
    return m.data_type === 'uint8' ? 0 : NaN;
  }
  const index = coords.map((v, i) => v % shape[i]).reduce((n, v, i) => n * shape[i] + v, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return m.data_type === 'float32'
    ? view.getFloat32(index * 4, true)
    : m.data_type === 'float64'
      ? view.getFloat64(index * 8, true)
      : view.getUint8(index);
}
const verified = [];
for (const sample of report.sourceSamples) {
  const [x, y, z] = sample.index;
  const value = await cell(`${sample.path}/0`, [z, y, x]);
  const mask = await cell(`${sample.path}/validity`, [z, y, x]);
  const ground = await cell(`${sample.path}/ground_elevation`, [y, x]);
  assert.equal(value, sample.value);
  assert.equal(mask, 1);
  assert.equal(ground, sample.ground);
  const center = await cell(`${sample.path}/z`, [z]);
  assert.ok(Math.abs(center - sample.physicalZ) <= 2.50001);
  const affine = metadata[sample.path].attributes['spatial:transform'],
    mx = affine[2] + (x + 0.5) * affine[0],
    my = affine[5] + (y + 0.5) * affine[4],
    circumference = 2 * Math.PI * 6378137;
  const common = [
    ((mx + circumference / 2) * 512) / circumference,
    ((my + circumference / 2) * 512) / circumference,
  ];
  assert.ok(common.every((v, i) => Math.abs(v - sample.commonCenter[i]) < 1e-10));
  const latitude = Math.atan(Math.sinh(my / 6378137)),
    scale = 512 / (40.03e6 * Math.cos(latitude));
  const display = (ground + 20 * (sample.physicalZ - ground)) * scale;
  assert.ok(Math.abs(display - sample.displayZ) < 1e-8);
  const ox = Math.floor(x / 2),
    oy = Math.floor(y / 2),
    children = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      children.push(await cell(`${sample.path}/0`, [z, oy * 2 + dy, ox * 2 + dx]));
    }
  }
  const valid = children.filter(Number.isFinite),
    mean = await cell(`${sample.path}/1`, [z, oy, ox]);
  assert.ok(Math.abs(mean - valid.reduce((a, b) => a + b, 0) / valid.length) < 1e-6);
  verified.push({
    ...sample,
    sourceValue: value,
    sourceGround: ground,
    sourceVerticalCenter: center,
    level1Mean: mean,
    nativeChildrenValid: valid.length,
    nativeChildrenMissing: 4 - valid.length,
    displayError: Math.abs(display - sample.displayZ),
  });
}
let gap;
const sample = report.sourceSamples[0];
for (let dy = -4; dy <= 4 && !gap; dy++) {
  for (let dx = -4; dx <= 4 && !gap; dx++) {
    const x = Math.floor(sample.index[0] / 2) + dx,
      y = Math.floor(sample.index[1] / 2) + dy,
      z = sample.index[2],
      mean = await cell(`${sample.path}/1`, [z, y, x]);
    if (!Number.isFinite(mean)) {
      continue;
    }
    const values = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        values.push(await cell(`${sample.path}/0`, [z, y * 2 + j, x * 2 + i]));
      }
    }
    const count = values.filter(Number.isFinite).length;
    if (count > 0 && count < 4) {
      gap = {
        path: sample.path,
        overviewIndex: [x, y, z],
        mean,
        nativeValues: values.map((v) => (Number.isFinite(v) ? v : null)),
      };
    }
  }
}
assert.ok(gap, 'A finite stored overview with native holes must be demonstrated');
// Three independently published models overlap at the same native physical cell.
const paths = [
  'coarse_fraction/survey-area-9-act-run-hf-line-no',
  'coarse_fraction/survey-area-9-act-run-mod-line-no',
  'coarse_fraction/survey-area-9-act-run-norm-line-no',
];
const model = paths[1],
  m = metadata[`${model}/0`],
  affine = metadata[model].attributes['spatial:transform'];
const firstZ = await cell(`${model}/z`, [0]);
const native = await decodedChunk(`${model}/0`, [0, 0, 0]);
assert.ok(native.data);
const sourceView = new DataView(native.data.buffer, native.data.byteOffset, native.data.byteLength);
let overlap,
  candidates = 0;
for (let z = 0; z < m.shape[0] && !overlap; z++) {
  for (let y = 0; y < m.shape[1] && !overlap; y++) {
    for (let x = 0; x < m.shape[2] && !overlap; x++) {
      const value = sourceView.getFloat32(
        (x + native.shape[2] * (y + native.shape[1] * z)) * 4,
        true,
      );
      if (!Number.isFinite(value) || candidates++ > 1500) {
        continue;
      }
      const mx = affine[2] + (x + 0.5) * affine[0],
        my = affine[5] + (y + 0.5) * affine[4],
        height = firstZ + z * 5,
        models = [];
      for (const path of paths) {
        const a = metadata[path].attributes['spatial:transform'],
          bottom = await cell(`${path}/z`, [0]);
        const coords = [
          Math.round((height - bottom) / 5),
          Math.round((my - a[5]) / a[4] - 0.5),
          Math.round((mx - a[2]) / a[0] - 0.5),
        ];
        const fraction = await cell(`${path}/0`, coords);
        models.push({
          path,
          index: [coords[2], coords[1], coords[0]],
          fraction,
          ground: await cell(`${path}/ground_elevation`, coords.slice(1)),
        });
      }
      if (
        models.every((v) => Number.isFinite(v.fraction)) &&
        new Set(models.map((v) => v.fraction)).size > 1
      ) {
        overlap = { physicalCenter: [mx, my, height], owner: paths[0], models };
      }
    }
  }
}
assert.ok(overlap, 'A conflicting three-model native overlap must be demonstrated');
const output = {
  verifiedCells: verified,
  nativeGapWithinFiniteOverview: gap,
  nativeModelOverlap: overlap,
  independentDecoder:
    'HTTP ranges, CRC32C, gzip and little-endian float reads using Node built-ins; no Zarrita or viewer reader.',
};
await writeFile(path.join(directory, 'source-verification.json'), JSON.stringify(output, null, 2));
console.log(
  `Verified ${verified.length} visible native cells, ground elevations, physical Z intervals, overview means, projection units and 20x placement; demonstrated a finite overview crossing a native gap.`,
);
