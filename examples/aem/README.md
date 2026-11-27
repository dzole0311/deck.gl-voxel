[California DWR airborne electromagnetic surveys](https://data.cnra.ca.gov/dataset/aem) estimate the fraction of coarse sediment below ground; this example streams those grids as GeoZarr cells.

```ts
import { Deck, MapView } from '@deck.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { ZarrVoxelLayer } from 'deck.gl-voxel-zarr';

new Deck({
  views: new MapView({ nearZMultiplier: 0.02, farZMultiplier: 4 }),
  initialViewState: { longitude: -119.55, latitude: 36.5, zoom: 10.8, pitch: 62 },
  controller: true,
  deviceProps: { type: 'webgpu', adapters: [webgpuAdapter] },
  layers: [
    new ZarrVoxelLayer({
      id: 'aem',
      source: import.meta.env.VITE_AEM_ZARR_URL,
      renderMode: 'cells',
      sourceOptions: {
        field: 'coarse_fraction',
        verticalCoordinates: 'z',
        groundElevation: 'ground_elevation',
        validity: 'validity',
      },
      palette: new Uint8Array([94, 79, 162, 255, 213, 62, 79, 255]),
      valueRange: [0, 1],
      exaggeration: 20,
    }),
  ],
});
```
