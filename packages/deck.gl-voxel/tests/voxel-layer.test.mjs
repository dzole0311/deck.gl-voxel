import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { prepareCellMesh, VoxelDepthEffect, VoxelLayer } from '../dist/index.js';
import { CellLayer } from '../dist/rendering/cell-layer.js';
import { RaymarchVoxelLayer } from '../dist/rendering/raymarch-layer.js';

const volume = { values: new Float32Array([0.5]), dimensions: [1, 1, 1] };
const palette = new Uint8Array([50, 136, 189, 255, 213, 62, 79, 255]);
const mesh = await prepareCellMesh(
  {
    dimensions: [1, 1, 1],
    origin: [10, 20, 90],
    spacing: [2, -3, 5],
    values: new Float32Array([0.5]),
    valueDimensions: [1, 1, 1],
    valueScale: 1,
    validity: new Uint8Array([1]),
    ground: new Float32Array([100]),
    elevationScales: new Float32Array([0.01]),
  },
  2,
  [0, 1],
);

test('dense facade selects an internal raymarch renderer and retains mode-specific defaults', () => {
  const layer = new VoxelLayer({ id: 'data', volume });
  const child = layer.renderLayers();
  assert.ok(child instanceof RaymarchVoxelLayer);
  assert.equal(child.id, 'data-raymarch');
  assert.equal(child.props.volume, volume);
  assert.equal(child.props.renderMode, 'volume');
  assert.equal(child.props.pickable, false);
  assert.equal(child.props.parameters.depthWriteEnabled, false);
  assert.equal(child.props.parameters.blendColorDstFactor, 'one-minus-src-alpha');
  assert.equal(layer.getBounds(), null);
  const surface = new VoxelLayer({ id: 'data', volume, renderMode: 'isosurface' }).renderLayers();
  assert.equal(surface.id, child.id);
  assert.equal(surface.props.volume, volume);
  assert.equal(surface.props.renderMode, 'isosurface');
});

test('cell facade preserves prepared input, physical clipping, picking and opaque depth defaults', () => {
  const physicalClipBounds = [10.5, 17, 91, 12, 20, 94];
  const layer = new VoxelLayer({
    id: 'data',
    renderMode: 'cells',
    mesh,
    palette,
    exaggeration: 20,
    physicalClipBounds,
  });
  const child = layer.renderLayers();
  assert.ok(child instanceof CellLayer);
  assert.equal(child.id, 'data-cells');
  assert.equal(child.props.mesh, mesh);
  assert.equal(child.props.palette, palette);
  assert.equal(child.props.clipBounds, physicalClipBounds);
  assert.equal(layer.props.clipBounds, undefined);
  assert.equal(child.props.pickable, true);
  assert.equal(child.props.parameters.depthWriteEnabled, true);
  assert.equal(child.props.parameters.depthCompare, 'less');
  assert.equal(child.props.parameters.blendColorDstFactor, 'zero');
  assert.equal(
    new VoxelLayer({ id: 'unclipped', renderMode: 'cells', mesh, palette }).renderLayers().props
      .clipBounds,
    undefined,
  );
  assert.equal(
    new VoxelLayer({
      id: 'unpickable',
      renderMode: 'cells',
      mesh,
      palette,
      pickable: false,
    }).renderLayers().props.pickable,
    false,
  );
});

test('explicit GPU parameters override only the selected backend defaults', () => {
  for (const props of [{ volume }, { renderMode: 'cells', mesh, palette }]) {
    const child = new VoxelLayer({
      id: 'configured',
      ...props,
      parameters: { cullMode: 'none' },
    }).renderLayers();
    assert.equal(child.props.parameters.cullMode, 'none');
    assert.equal(child.props.parameters.depthWriteEnabled, props.renderMode === 'cells');
    assert.equal(
      child.props.parameters.blendColorDstFactor,
      props.renderMode === 'cells' ? 'zero' : 'one-minus-src-alpha',
    );
  }
});

test('fresh backend replacements have separate IDs while same-mode clones preserve source objects', () => {
  const dense = new VoxelLayer({ id: 'data', volume });
  const cells = new VoxelLayer({ id: 'data', renderMode: 'cells', mesh, palette });
  const denseAgain = new VoxelLayer({ id: 'data', volume });
  assert.notEqual(dense.renderLayers().id, cells.renderLayers().id);
  assert.equal(dense.renderLayers().id, denseAgain.renderLayers().id);
  assert.equal(denseAgain.renderLayers().props.volume, volume);
  assert.equal(dense.clone({ density: 2 }).renderLayers().props.volume, volume);
  const cloned = cells.clone({ visibleBins: 1 }).renderLayers();
  assert.equal(cloned.props.mesh, mesh);
  assert.equal(cloned.props.palette, palette);
  assert.equal(cloned.props.visibleBins, 1);
});

test('runtime mode checks reject mixed inputs and conflicting clipping units', () => {
  assert.throws(
    () =>
      new VoxelLayer({ id: 'invalid', renderMode: 'cells', mesh, palette, volume }).renderLayers(),
    /without a dense volume/,
  );
  assert.throws(
    () =>
      new VoxelLayer({
        id: 'invalid',
        renderMode: 'cells',
        mesh,
        palette,
        clipBounds: [0, 0, 0, 1, 1, 1],
      }).renderLayers(),
    /physicalClipBounds/,
  );
  assert.throws(
    () => new VoxelLayer({ id: 'invalid', volume, mesh }).renderLayers(),
    /without cell inputs/,
  );
  assert.throws(
    () => new VoxelLayer({ id: 'invalid', renderMode: 'other', volume }).renderLayers(),
    /renderMode/,
  );
  assert.throws(
    () => new VoxelLayer({ id: 'invalid', renderMode: 'cells', mesh }).renderLayers(),
    /mesh and palette/,
  );
});

test('depth capture excludes composite and raymarch layers and filters opaque leaves', () => {
  const selected = [];
  const effect = new VoxelDepthEffect({
    getLayerFilter: (layer) => {
      selected.push(layer);
      return layer.id === 'opaque';
    },
  });
  effect.setup({ device: { type: 'webgpu' } });
  const facade = new VoxelLayer({ id: 'dense', volume });
  const opaque = new SimpleMeshLayer({ id: 'opaque', mesh: null });
  const other = new SimpleMeshLayer({ id: 'other', mesh: null });
  assert.equal(effect.pass.shouldDrawLayer(facade), false);
  assert.equal(effect.pass.shouldDrawLayer(facade.renderLayers()), false);
  assert.equal(
    effect.pass.shouldDrawLayer(
      new VoxelLayer({ id: 'cells', renderMode: 'cells', mesh, palette }).renderLayers(),
    ),
    false,
  );
  assert.equal(effect.pass.shouldDrawLayer(opaque), true);
  assert.equal(effect.pass.shouldDrawLayer(other), false);
  assert.deepEqual(selected, [opaque, other]);
  effect.cleanup();
});
