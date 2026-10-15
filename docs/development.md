# Development

Use Node.js 22 or later and pnpm 10.33.0.

- `pnpm install`: install dependencies
- `pnpm build`: build workspace packages
- `pnpm typecheck`: check TypeScript
- `pnpm check`: check formatting and lint
- `pnpm format`: format files
- `pnpm --filter deck.gl-voxel dev`: rebuild the library on changes

The library starts in `packages/voxel/src/index.ts`. Builds produce JavaScript and type declarations in `dist/`.

Add runnable demos under `examples/`. Both workspace and library are private until we set up publishing.
