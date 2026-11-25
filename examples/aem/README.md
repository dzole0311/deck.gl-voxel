# AEM GeoZarr explorer

Run `pnpm install`, then `pnpm dev:aem` from the workspace root. Vite prints the available local URL (normally `http://127.0.0.1:5176`). Use Chrome with WebGPU enabled. No data download, conversion or preprocessing step is required. Optional URL overrides are in `.env.example`.

The example streams the [published AEM Zarr v3 store](https://d3d0qchq1igql3.cloudfront.net/aem/dwr-2026-11-23-v4/aem.zarr/zarr.json) and pinned [DWR context snapshots](https://huggingface.co/datasets/gjoremilevski/california-dwr-aem-context/tree/53a7f9c2ab762bd460e90f8a0d5380663180fd28/context). The original data and scientific interpretation belong to [California DWR](https://data.cnra.ca.gov/dataset/aem).

## Rendering choice

The installed versions are deck.gl **9.3.12**, luma.gl **9.3.5**, Zarrita **0.7.5** and `@developmentseed/geozarr` **0.10.0**. Inspect these versions before consulting newer examples: deck.gl's [current WebGPU matrix](https://deck.gl/next/docs/developer-guide/webgpu) includes capabilities added in 9.4.

| Approach                       | Fit for this example                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GridCellLayer / ColumnLayer    | The 9.3.12 [ColumnLayer source](https://unpkg.com/@deck.gl/layers@9.3.12/src/column-layer/column-layer.ts) supplies GLSL only. GridCellLayer inherits that renderer. An extrusion per XY position also needs adaptation for independent values along depth, per-column ground, missing cells, cuts and physical picking. |
| SimpleMeshLayer                | The installed [9.3.12 source](https://unpkg.com/@deck.gl/mesh-layers@9.3.12/src/simple-mesh-layer/simple-mesh-layer.ts) also supplies GLSL only. Porting and extending it would be more work than the small cell renderer.                                                                                               |
| Translucent volume raymarching | Remains appropriate for the existing weather examples. Opaque geological categories need precise first-cell boundaries, physical holes and depth-writing surfaces. Sampling a long opaque ray introduces avoidable stepping and precision tradeoffs.                                                                     |
| Custom instanced cuboids       | Chosen: one immutable storage buffer per displayed tile, one draw per tile, 12 rasterized triangles per vertical run, plus a near-plane cap triangle. Adjacent vertical cells with the same display bin merge. Native XY coverage and every category boundary remain exact.                                              |

`deck.gl-voxel` owns `CellLayer`, mesh preparation, clipping, the ground transform, GPU resources and CPU picking. A new mesh object triggers one buffer upload; camera and category changes update uniforms. Every buffer and model is released by its layer. Color blending explicitly overwrites opaque pixels; ordinary depth testing determines the closest surface. Sorted tile order and strict depth comparison make coplanar ties deterministic. Picking uses that same order and the same cuboids.

Both sides render, so the camera may move below ground or inside the data. A special triangle caps cuboids cut by the camera's near plane, including a camera starting inside a cell. Its screen extent is restricted to the near-plane intersection to avoid full-screen work for off-screen cells. `CellLayer.clipBounds` and `pickCellMesh` accept XY bounds in common coordinates and Z bounds in physical meters. Clamping each cuboid closes the cut faces and keeps future axis-aligned slicing possible. There is no slicing UI. Oblique slicing would require an additional plane/cap implementation.

The tradeoff is internal cuboid faces: this is a compact instanced mesh, not a precomputed exterior-only mesh. Removing hidden faces across categories would make filtering and exposed cuts more complicated. Native masks and values must be read before claiming measured coverage, so this design favors truthful gaps over immediate coarse solid blocks. See `VALIDATION.md` for measured navigation and resource costs.

## Verified store layout

Metadata is interpreted by [@developmentseed/geozarr](https://developmentseed.org/deck.gl-raster/api/geozarr/). Array access, gzip decoding, shard indexes and missing chunks remain Zarrita responsibilities.

- 27 independently georeferenced coarse-fraction fields cover Survey Areas 1–11. Their scalar arrays are named `0`–`5` with dimensions **Z, Y, X**. Native values are continuous fractions in `[0,1]`, including valid zero; NaN marks missing values. Source flags are excluded from the fraction grids.
- XY is north-up, pixel-registered **EPSG:3857**, with 250 Mercator units per native cell. Rows advance south. These are visualization grids resampled from soundings, not the original acquisition spacing. A Mercator unit is not a ground meter at California latitudes.
- Positive-up `z` arrays contain uniformly spaced **5 m physical elevation centers**. The first outside edge is the first center minus half a step. The publication does not identify the original Topo vertical datum; the example retains those physical elevations without inventing a datum conversion.
- Stored overviews double XY spacing through 8,000 Mercator units and leave Z unchanged. They are means of valid native fractions, using native counts. Their coarse finite footprint can cover native holes. The renderer therefore uses the separate native `validity` array at every level.
- Native `ground_elevation` is a YX meter-valued array. Its NaNs do not become zero ground. A cell without a finite ground reference is omitted.
- Scalar arrays use indexed shards, typically outer `[64,256,256]` with inner `[64,128,128]` chunks; small fields and overviews have adaptive XY sizes. Ground uses outer `[512,512]`, inner `[256,256]`. Validity is unsharded uint8, typically `[128,256,256]`. Actual logical chunk dimensions come from Zarrita's `array.chunks`, including its sharding support.
- Shard indexes are at the **start**. Zarrita 0.7.5's installed getter requests suffix indexes unconditionally. `withStartShardIndexes` translates only those suffix reads to offset zero for arrays explicitly declaring `index_location: start`. All index decoding, CRC, chunk offsets and gzip decoding still use Zarrita. A regression test decodes an independently assembled start-index shard. Remove this adapter when upgrading to a Zarrita release that handles this metadata itself.

The native allocated grids contain 1,255,748,550 cell slots, but metadata reports only 6,934,544 valid cells. Dense statewide allocations would therefore waste considerable memory. Retained masks are bit-packed and sparse finite scalar values use sorted index/value arrays. No replacement dataset is generated.

## Loading and refinement

`GeoZarrCellSource` owns metadata, logical chunk caching, bounded requests, cancellation, retry, view selection and refinement. The application supplies field paths, ten display bins, a value range, palette and camera.

The source selects independent 128×128-native-cell XY footprints throughout the frustum. It evaluates both horizontal cell edges at the center and visible portions of each footprint, so rotation cannot hide a clearly visible edge and a distant part of a broad survey does not force its close visible region to use the same level. Stored levels target about two screen pixels per value cell. A 1.25–3 pixel hysteresis band avoids toggling on small zoom reversals.

An initial stored overview may appear first. A finer result replaces that tile atomically: there are never two overlapping coarse/fine draw layers. Both use the same native coverage and ground, so native gaps and physical placement remain fixed as colors refine. Missing chunks are confirmed fill values; an unfinished tile stays pending. Existing displayed values remain available on temporary failures. HTTP reads retry three times with deadlines; failed tile reads back off and retry without requiring camera movement.

Three tile preparations and six logical chunk reads may run concurrently. Requests for the same decoded chunk share the existing `ChunkCache`; its queue and subscriber cancellation retain reads still needed by another tile. Small camera changes preserve useful in-flight reads. Off-screen work is cancelled. Return visits reuse decoded chunks and prepared meshes.

The decoded LRU is 192 MiB and the prepared-mesh LRU is 256 MiB. Prepared tiles currently displayed are pinned: the mesh-cache figure can exceed its retention target if an unusually large view requires it; the UI explicitly reports that condition. It does not silently stop refinement or remove measured coverage to meet an arbitrary cell cap. These figures exclude bounded in-flight decoding, browser caches, context and GPU copies. Context uses a pinned compressed snapshot, a 12,000-row log-group LRU and up to 4,000 displayed lithology intervals, keeping complete wells together. There is no claim that the cache target is a total process-memory ceiling.

### Overlap policy

Independent shard reads demonstrate different HF, MOD and normal-model fractions at one shared native XYZ cell in Survey Area 9. There is no published quality rank among the overlapping fields. The **lexicographically first selected field with a valid native physical cell wins**. Lower-priority values survive where that native cell is missing in the earlier field. Ownership is resolved using native masks in aligned physical XYZ coordinates, before category visibility is applied. Hiding a winning category does not reveal another survey underneath. It is a deterministic display policy, not a claim that one scientific interpretation is better. The same owned meshes drive rendering and picking.

### Ground, context and inspector

Every native column uses:

```text
displayZ = groundZ + 20 * (physicalZ - groundZ)
```

Conversion from physical meters to common-space Z uses the latitude of each native row and math.gl 4.1.0’s installed `40.03e6` meter circumference, matching deck.gl’s meter convention. XY EPSG:3857 coordinates separately use its 6,378,137 meter radius. Ground remains fixed. Picking inverts the same transform; tooltips report physical elevations and fraction values, and explicitly identify stored overview averages.

The focus-depth control moves the camera target below local ground. Right-drag rotates; pitches beyond the horizon and the “View from below” control support underground exploration. The map is a faint, non-occluding backdrop. Its updates stop while hidden. It shares the camera's center, focus elevation, pitch, bearing, zoom and field of view and is hidden for below-horizon views and when the camera moves below the datum plane. MapLibre 6.17 requires setting the focus elevation after construction to avoid an initialization error. It also needs an explicit 85-degree pitch limit rather than its 60-degree default. Numerical browser checks compare datum-plane landmarks between both camera stacks.

Published flight assets are **ground footprints, not aircraft altitude**. They are attached only where a finite native ground elevation is loaded. Borehole lithology uses its published ground elevation and meter depths through the same 20× formula. Source intervals with missing or invalid elevations/depths are skipped. The interval display budget is separate from scalar refinement.

The shared chunk inspector shows actual scalar level/chunk coordinates, loading state and the native footprint contributing to the displayed result. A stored overview chunk may serve multiple disjoint native footprints. Displayed coarse chunks remain marked ready while requested finer chunks are listed separately. Confirmed empty chunks are listed without invented displayed outlines. Z bounds include local-ground exaggeration and are split by actual logical Z chunks. The camera inset and main-view outlines use the renderer's common-space envelope and projection matrix.

## Validation commands

From the workspace root:

```sh
pnpm check
pnpm test
pnpm test:browser
AEM_ARTIFACTS=/absolute/output/directory pnpm test:aem
node examples/maplibre/tests/browser.mjs
```

The last command uses the published dataset and writes screenshots, transition frame sequences, source pick indices and a JSON profile. It checks default settling, gradual refinement, small transition oscillations, zoom reversals, survey changes, low-angle rotation, below-ground/inside views, Asia and return, context, the inspector, interrupted requests and temporary HTTP failures. Expected 404 responses represent omitted fill chunks and are distinguished from unexpected errors. The focused opaque suite also exercises all-instance draws, palette colors, category filtering, native holes, clipping and near-plane caps. The existing translucent renderer remains covered by the original WebGPU suite.
