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
