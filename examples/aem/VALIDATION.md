# AEM validation, 2026-11-25

The published dataset was exercised end to end in Chrome **158.0.8127.88** on macOS, using an Apple Metal 3 WebGPU adapter, a **1400×1000** viewport and device pixel ratio **1**. Node was **24.5.0**. Validation used uncommitted changes based on main `a6061da`.

The rendering and metadata decisions are explained in [README.md](README.md). The browser run writes `report.json`, `source-verification.json` and numbered PNG captures to `AEM_ARTIFACTS`. These are measurements of this machine and browser session, not a performance guarantee for other devices.

## Results and reproducibility

The following checks passed:

- `pnpm check`: formatting, Biome and TypeScript builds.
- `pnpm test`: 66 unit tests, including native masks, overlap ownership, retry recovery, cached return visits, start-index shards, shared cancellation, rotation-sensitive resolution, ground-relative placement, physical picking and signed Cartesian bounds.
- `pnpm test:aem`: focused opaque WebGPU pixels, published-data interaction sequences and independent source verification.
- `pnpm test:browser`: the existing translucent renderer's transfer function, opacity correction, clipping, missing data, axes, depth, progressive loading, resizing and resource disposal.
- `node examples/maplibre/tests/browser.mjs`: weather-example controls, inspector, cache reuse and playback. The resize check now waits for the resulting load before asserting idle status.
- `pnpm --filter voxel-aem-example build`: production build. Vite reports large dependency chunks and third-party `use client` directives; the build succeeds.

To reproduce the scientific and interaction evidence:

```sh
AEM_ARTIFACTS=/absolute/output/directory pnpm test:aem
```

The focused GPU fixture checks all four native instances, exact category colors, category hiding and physical cut surfaces. For near-plane caps it independently unprojects pixel centers onto the near plane, selects points strictly inside measured cuboids and checks their unshaded category color. This verifies the exposed cap rather than merely checking that some colored pixels remain visible.

## Interaction and visual evidence

The saved sequence covers initial loading and the settled Kingsburg view; gradual zoom from 8 to 13.4 with intermediate loading frames; repeated ±0.025 zoom changes near a level transition; zoom out and return; continuous movement from Kingsburg toward Salinas; 82-degree pitch at bearings 90 and 40; 120-degree pitch from below; an inside-data camera; Salinas; Survey Area 9 overlap; the shared inspector; flight footprints and borehole intervals; sparse Survey Area 2 overview coverage; interrupted reads; HTTP 503 recovery; selection changes during reads; and a final return.

The broad settled view used 353 native footprints and 1,287,356 vertical runs, with 72 footprints at L0, 183 at L1 and 98 at L2. The default view used 88 L0 footprints and 399,921 runs. Detail therefore varies by region without a manual level control. Coarse/fine replacement uses one mesh per footprint, with native coverage fixed throughout.

All 257 footprints shared by the transition samples retained their levels: there were zero back-and-forth level toggles. Asia displayed no AEM tiles and caused zero AEM chunk requests. Returning to the same camera reproduced identical data pixels, with the backdrop disabled during this comparison. Intermediate zoom and boundary-pan captures show loaded coverage while three preparations continue in the background.

The inspector lists actual logical scalar chunk coordinates and levels, distinguishes retained coarse results from finer pending work and uses the same exaggerated common-space bounds as the renderer. Confirmed empty contributions have no invented outline. Datum-plane landmark alignment between MapLibre and deck.gl was within **0.000205 CSS pixels** in the numerical camera comparison. The backdrop is automatically hidden below the horizon and for the tested below-datum cameras.

The context capture contained 7,203 flight-ground segments and 4,000 lithology intervals. Flight lines are labeled as ground footprints. Lithology uses physical interval depths and the published well ground elevation; complete wells remain together within the explicit context display budget.

Four aborted requests and six HTTP 503 responses were deliberately injected. The viewer recovered without reloading. These ten expected failures are recorded separately from unexpected errors. There were no unexpected runtime or GPU validation errors. Three OpenFreeMap road-shield warnings about null filter properties remain external map-style warnings.

## Independent scientific checks

The source verifier uses HTTP byte ranges, CRC32C, gzip and little-endian float reads from Node built-ins. It does not use Zarrita or the viewer reader.

Six visibly picked native cells matched their published fractions, validity and local ground elevations. Each physical hit elevation lay inside the correct 5 m source interval. XY centers matched the EPSG:3857 affine. The 20× ground-relative display transform matched the independent calculation within **1.14e-9 common-space units**, including math.gl's installed physical-meter conversion convention.

Independent L1 reads matched valid-native-child means. One finite L1 value of 0.4896667 spans native children `[0.621, 0.411, NaN, 0.437]`, demonstrating why a finite overview must retain the native hole. Regression tests verify that hole remains missing in geometry and picking, including valid category zero.

At EPSG:3857 center `[-13336875, 4420625]`, physical elevation `-77.5 m`, the overlapping Survey Area 9 HF, MOD and normal fields contain fractions approximately 0.121, 0.177 and 0.112. All share ground elevation 76.6 m. No scientific quality rank is published. The documented lexical ownership policy selects HF when all three fields are selected; native-mask regression tests verify deterministic ownership and category behavior.

## Navigation measurements

Each profile continuously varies bearing and longitude, recording 150 animation-frame intervals, except the broad profile's 120 intervals. Zero main-thread long tasks occurred inside these four profile windows.

| View    | Frame p50 | Frame p95 | Frame p99 | Maximum | GPU queue completion p95 |
| ------- | --------: | --------: | --------: | ------: | -----------------------: |
| Default |   16.7 ms |   20.8 ms |   35.6 ms | 42.6 ms |                  18.4 ms |
| Broad   |   16.8 ms |   19.7 ms |   22.0 ms | 23.8 ms |                  84.0 ms |
| Close   |   16.7 ms |   17.6 ms |   20.6 ms | 23.6 ms |                   5.6 ms |
| Return  |   16.6 ms |   20.3 ms |   44.9 ms | 76.9 ms |                  24.3 ms |

Queue completion uses asynchronous `GPUQueue.onSubmittedWorkDone()` fences. It includes outstanding work and callback delivery; it is **not a GPU timestamp or presentation-latency measurement**. The broad view's queue delay shows GPU pressure despite near-60 Hz animation callbacks. No GPU timestamp queries were enabled. The full session also recorded 14 long tasks of 52–145 ms during loading, transitions and other work outside the steady profile windows. Initial default settling took **5.71 seconds**, including startup and remote reads, with a new browser context.

Near-plane cap triangles are restricted to the projected intersection of each cell with the near plane. In the immediately preceding full-screen-cap comparison, default queue-completion p95 was 101.3 ms and close p95 was 14.3 ms. The final values above reflect the restricted cap and reduced temporary shader storage.

GPU resources were retained during camera movement: 58 of 61 default models and 218 of 220 broad models survived their respective profiles; all 19 close models survived and no close meshes were prepared. Ten default footprints and two broad footprints required legitimate regional level changes. Camera changes update uniforms; unchanged meshes are not uploaded again.

Luma reported 174 active buffers and about 18.7 MiB of GPU resources after both default and return profiles, 660 buffers / 46.1 MiB in the broad view and 57 buffers / 10.3 MiB close up. These counters cover the deck device's tracked buffers and attachments, excluding the separate MapLibre device and driver overhead. Installed luma WebGPU vertex-array destruction is a no-op, so its cumulative vertex-array counter is not evidence of live GPU allocation; buffer counts and bytes are the relevant counters here.

The largest sampled decoded-plus-prepared CPU retention was **447.4 MiB**. After explicit garbage collection at the final return, Chrome reported about 56.3 MiB of used JavaScript heap and 441.7 MiB of backing storage. Retention targets are not total process-memory limits: displayed meshes are pinned, and in-flight work, context, browser caches and GPU copies are separate.

## Remaining limits

WebGPU and a capable GPU are required. Broad views still submit internal cuboid faces and have measurable GPU queue pressure; loading and rapid transitions can produce brief main-thread pauses. This implementation supports the documented north-up EPSG:3857 collection layout and aligned stored XY overviews, rather than every possible GeoZarr projection or rotated grid. It supports axis-aligned physical cuts but has no slicing UI or oblique cap implementation. Source vertical elevations are retained without inventing a datum conversion. Context intervals have a separate, visible 4,000-interval budget; scalar refinement has no arbitrary cell cap.
