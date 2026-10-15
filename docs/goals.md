# Goals

Visualize multidimensional geospatial data as interactive 3D volumes with deck.gl.

(Gjore): Listing few initial use cases and requirements, these will probably change as development progresses.

## Initial use cases

- Inspect weather model data in 3D
- Slice volumes and select height or time ranges
- Use the layer in a deck.gl application

## Requirements

- Read GeoZarr data initially, directly in the browser. Zarr alone doesn’t specify how to place the data geographically so supporting it would require callers to supply that information
- Look into reusing Zarr loading from [deck.gl-zarr](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/deck.gl-zarr) and [GeoZarr utilities](https://github.com/developmentseed/deck.gl-raster/tree/main/packages/geozarr) to help with future integration into existing deck.gl apps
- Compare rendering approaches with most cells visible and with only a small portion visible
- Measure frame time, loading time and memory use where measurable
- Provide a runnable example for review

