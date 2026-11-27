Render volumetric (Geo)Zarr data directly in the browser with deck.gl and WebGPU and keep numeric values available for interaction.

> [!NOTE]
> The API is still experimental and may change.

```sh
pnpm install
pnpm dev:maplibre
```

Open the [local example](http://127.0.0.1:5175/).

## Packages

- [Voxel layer](packages/deck.gl-voxel/README.md)
- [Zarr reader](packages/deck.gl-voxel-zarr/README.md)

## Tests

Run `pnpm check` and `pnpm test` locally. Run `pnpm test:browser` for rendering tests in Chrome with WebGPU.

## Formatting and linting

`pnpm install` installs the Lefthook pre-commit hook. Before each commit, it checks staged files with Prettier and Biome. The hook reports errors without changing or staging files.

Run `pnpm format` to format files and `pnpm lint:fix` to apply safe lint and import fixes. Prettier handles formatting; Biome handles linting and import checks. `pnpm check` checks formatting, linting, and the TypeScript build across the workspace.

If hooks are missing after an install with scripts disabled, run `pnpm prepare`.
