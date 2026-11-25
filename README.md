# deck.gl-voxel

Experimental deck.gl layer for visualizing volumetric data with WebGPU. It supports translucent volumes, isosurfaces and opaque geological cells.

Earlier example using `SimpleMeshLayer` and `CubeGeometry` in [deck.gl-voxel-prototype](https://github.com/dzole0311/deck.gl-voxel-prototype).

## Run the example

The [MapLibre example](examples/maplibre/README.md) shows cloud cover (generated from ERA5) and wind speed over time fetched from dynamica.org.

Note: Use Node.js 22.13 or later in the 22.x series or Node.js 23.5 or later. The example requires a browser with WebGPU.

```sh
pnpm install
pnpm dev:maplibre
```

Open the [local example](http://127.0.0.1:5175/).

The [AEM GeoZarr example](examples/aem/README.md) streams California DWR survey grids, including sparse coverage, automatic refinement and underground exploration. Run `pnpm dev:aem`; Vite prints the available local URL.

## Packages

- [Voxel layer](packages/deck.gl-voxel/README.md)
- [Zarr reader](packages/deck.gl-voxel-zarr/README.md)

## Tests

Run `pnpm check` and `pnpm test` locally. Run `pnpm test:browser` for rendering tests in Chrome with WebGPU.

## Formatting and linting

`pnpm install` installs the Lefthook pre-commit hook. Before each commit, it checks staged files with Prettier and Biome. The hook reports errors without changing or staging files.

Run `pnpm format` to format files and `pnpm lint:fix` to apply safe lint and import fixes. Prettier handles formatting; Biome handles linting and import checks. `pnpm check` checks formatting, linting, and the TypeScript build across the workspace.

If hooks are missing after an install with scripts disabled, run `pnpm prepare`.
