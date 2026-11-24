# deck.gl-voxel-zarr

Pass the store URL and a `field` path to `openZarrVolume()`. The reader supports `float32` arrays in Zarr v2 and v3. Give the result of `readFrame()` to `VoxelLayer` as `volume`.

## GeoZarr

See [`ZarrVolumeOptions`](src/zarr-volume.ts#L33) and the [GeoZarr conventions](https://geozarr.org/conventions.html).

```ts
import { openZarrVolume } from 'deck.gl-voxel-zarr';

const clouds = await openZarrVolume('https://example-bucket.s3.amazonaws.com/volume.zarr', {
  field: 'fraction_of_cloud_cover',
  level: '2',
  verticalDimension: 'height',
  verticalCoordinates: 'height',
});

const volume = await clouds.readFrame(36);
```

## Plain Zarr

See [`ZarrVolumeLayout`](src/zarr-volume.ts#L11).

```ts
import { openZarrVolume } from 'deck.gl-voxel-zarr';

const temperature = await openZarrVolume(new URL('/data/experiment.zarr', location.origin).href, {
  field: 'temperature',
  layout: {
    axes: ['time', 'z', 'y', 'x'],
    origin: [0, 0, 0],
    spacing: [1, 1, -2],
  },
});

const volume = await temperature.readFrame(0);
```

## Layer usage

```ts
import { ZarrVoxelLayer } from 'deck.gl-voxel-zarr';

const layer = new ZarrVoxelLayer({
  id: 'clouds',
  source: 'https://example-bucket.s3.amazonaws.com/volume.zarr',
  sourceOptions: {
    field: 'fraction_of_cloud_cover',
    level: '2',
    verticalDimension: 'height',
    verticalCoordinates: 'height',
  },
  frameIndex: 36,
  valueRange: [0, 1],
  showBounds: true,
  onError: (error) => console.error(error),
});
```
