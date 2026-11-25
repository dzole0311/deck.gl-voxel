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

## Opaque GeoZarr collections

`GeoZarrCellSource` loads sparse opaque grids with stored overviews, native validity and local ground elevation. It owns metadata interpretation, view selection, sharding-compatible access through Zarrita, bounded chunk reads, shared cancellation, caching, retries and atomic tile refinement. The renderer package owns the mesh format, display transforms and picking.

```ts
import { GeoZarrCellSource } from 'deck.gl-voxel-zarr';

const source = await GeoZarrCellSource.open('https://example.com/data.zarr/', {
  fields: [
    {
      path: 'fraction',
      verticalCoordinates: 'z',
      groundElevation: 'ground_elevation',
      validity: 'validity',
    },
  ],
  bins: 10,
  valueRange: [0, 1],
});
```

The supported collection layout is consolidated Zarr v3, pixel-registered north-up EPSG:3857, named ZYX scalar arrays, named YX ground arrays, and uniform positive-up meter-valued Z centers. Stored XY levels must be aligned powers of two; Z is unchanged. Ground must publish its finite `actual_range`. `discoverGeoZarrCellFields` reads the consolidated catalog for application labels and field configuration.

Subscribe to `source.subscribe` for batched changes, then draw `source.getTiles()` using `CellLayer`. Each result includes its actual displayed level, immutable mesh and exaggerated common-space bounds. Update selection with `source.update(viewport, exaggeration, selectedFieldPaths)` whenever the camera changes. Field selection is optional and defaults to all configured fields. The source does not require the application to choose a resolution.

The default limits are six logical chunk reads, three tile preparations, a 192 MiB decoded LRU and a 256 MiB prepared-mesh LRU. Active displayed meshes are pinned; the source reports `budgetLimited` if their size exceeds the retention target rather than silently dropping coverage or stopping refinement. These are CPU retention budgets, excluding bounded in-flight work, GPU copies and browser caches. Inspect `getStats()` for actual usage. `getDebugState()` connects to the shared example inspector, with actual level/chunk identifiers and displayed native-mask contributions.

An earlier selected field wins valid physical cells in a native overlap, using lexicographic path order. Filtering its category does not reveal a lower-priority interpretation. Finer values replace an entire native footprint atomically while native gaps and ground remain fixed. Desired levels and prepared meshes survive off-screen trips; a cached target level is reused directly even after its initial overview has been evicted.

`dispose()` cancels payload and metadata requests and releases CPU caches. A caller-provided `signal` also cancels opening. Small shared shard-index requests follow the source lifetime, so cancellation of one inner chunk cannot repeatedly abort an index still needed by another. Individual payload requests remain cancellable.

See the [AEM rendering and data notes](../../examples/aem/README.md) for the verified published layout, the Zarrita 0.7.5 start-index compatibility adapter, controls, physical placement and tests.
