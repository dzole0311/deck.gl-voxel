# deck.gl-voxel

Experimental deck.gl layer for visualizing volumetric data with WebGPU.

## Example

```ts
import { Deck, OrbitView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { VoxelLayer } from 'deck.gl-voxel';

const deck = new Deck({
  canvas: 'volume',
  deviceProps: {
    type: 'webgpu',
    adapters: [webgpuAdapter],
  },
  views: new OrbitView({ orbitAxis: 'Z' }),
  initialViewState: { target: [0, 0, 0], rotationX: 25, rotationOrbit: 25, zoom: 3 },
  controller: true,
  layers: [
    new VoxelLayer({
      id: 'density',
      volume: {
        values: new Float32Array(16 * 12 * 8).fill(0.5),
        dimensions: [16, 12, 8],
        origin: [-8, -6, -8],
        spacing: [1, 1, 2],
      },
    }),
  ],
});
```

## Rendering

- `volume` shows the grid’s interior (increase `density` to make it less transparent)
- `isosurface` draws a surface where the data reaches `isovalue`

Volume opacity accumulates over distance in layer units after `modelMatrix`, using [reference-distance opacity correction](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-39-volume-rendering-techniques). Stretching the grid makes it thicker and more opaque. Rotation, translation, map projection and camera zoom do not change its absorption coefficient.

`opacityUnitDistance` defines the distance for one transfer-function alpha value and defaults to the smallest input cell spacing. Strong vertical exaggeration can hide more interior detail; use `density` to adjust the result. Isosurface lighting is independent of volume opacity.

Set `showBounds: true` to draw the full grid’s bounding box. The rear edges are dashed
and appear behind the voxels. The outline is off by default.

See the [layer props](src/types.ts) and the [MapLibre example](../../examples/maplibre/README.md).

## Opaque cells

`CellLayer` rasterizes opaque cells using an immutable `CellMesh` from `prepareCellMesh`. It merges adjacent vertical samples with the same display bin, preserves native gaps, writes depth and closes near-plane intersections. This is separate from translucent `VoxelLayer` rendering.

`CellGrid` uses X-fastest arrays. XY origin and spacing are Cartesian common coordinates; Z and `ground` are physical meters. `elevationScales` converts each row's physical meters to common units (use one for an ordinary Cartesian meter scene). `validity` describes native cells even when `values` comes from a coarser XY overview. See [the grid contracts](src/cell-grid.ts).

```ts
import { CellLayer, prepareCellMesh } from 'deck.gl-voxel';

const mesh = await prepareCellMesh(
  {
    dimensions: [2, 1, 2],
    origin: [0, 0, 980],
    spacing: [1, 1, 5],
    values: new Float32Array([0.1, 0.8, 0.2, 0.9]),
    valueDimensions: [2, 1, 2],
    valueScale: 1,
    validity: new Uint8Array([1, 0, 1, 1]),
    ground: new Float32Array([1000, 1005]),
    elevationScales: new Float32Array([1]),
  },
  2,
  [0, 1],
);

const layer = new CellLayer({
  id: 'opaque-cells',
  mesh,
  palette: new Uint8Array([50, 136, 189, 255, 213, 62, 79, 255]),
  exaggeration: 20,
});
```

The display transform is `ground + exaggeration * (physical - ground)`. `displayElevation`, `physicalElevation`, `getCellMeshBounds`, `pickCellMesh` and `pickCellCollection` share this convention. Supply camera rays in common coordinates. Collection picking skips irrelevant chunk bounds before checking cuboids. Use `visibleBins` to hide categories without rebuilding geometry. Palette alpha does not make these opaque cells translucent.

`clipBounds` keeps XY common-coordinate bounds and physical meter Z bounds. The exposed cuboid faces close automatically. Pass identical bounds to the picking helper when clipping. There is no oblique-plane slicing or arbitrary model-transform support in this renderer. Geometry is axis-aligned in common coordinates; GPU picking is disabled in favor of the reusable CPU helpers.

Callers own input arrays and meshes. Pass a new mesh or palette object to upload changed data. Each layer owns and releases its buffers and model. Camera movement preserves these resources. See the [AEM example](../../examples/aem/README.md) for projected data, source selection, an inspector and verification.
