`deck.gl-voxel-zarr` loads Zarr and GeoZarr data from URLs or readable stores through `ZarrVoxelLayer`.

```ts
import { ZarrVoxelLayer } from 'deck.gl-voxel-zarr';

const layer = new ZarrVoxelLayer({
  id: 'clouds',
  renderMode: 'volume',
  source: 'https://example.com/volume.zarr/',
  sourceOptions: {
    field: 'fraction_of_cloud_cover',
    verticalDimension: 'height',
    verticalCoordinates: 'height',
  },
  frameIndex: 0,
});
```
