# Sentinel-1 sample test

Possible input for the first rendering test.

`32UPB` is a [map tile ID](https://s2.pages.eopf.copernicus.eu/msi/s2msi/1.3.0/PDFS_ADFS/ADFS_MDs/S02_ADF_TILEP.html): zone `32`, latitude band `U`, grid square `PB`.

## Dataset

- [STAC item](https://api.explorer.eopf.copernicus.eu/stac/collections/sentinel-1-grd-rtc-staging/items/s1-rtc-32UPB): `s1-rtc-32UPB` in the staging collection
- [Zarr metadata](https://s3.explorer.eopf.copernicus.eu/esa-zarr-sentinel-explorer-fra/tests-output/sentinel-1-grd-rtc-staging/s1-rtc-32UPB.zarr/zarr.json): Zarr v3, with the groups and arrays described in one file
- Separate `ascending` and `descending` groups for northbound and southbound satellite passes
- CRS: `EPSG:32632` (WGS 84 / UTM zone 32N), with x/y coordinates in metres
- Variables: `vv` and `vh` measure radar return strength, stored as `float32` in linear power units, with `NaN` for missing values
- `border_mask` is `uint8`, with 0 marking invalid data according to STAC

## Dimensions and overviews

Each group has three images taken on different dates, stored as `(time, y, x)`. Both groups have the same array sizes and storage layout. STAC lists all six dates together.

Sizes below follow `(time, y, x)`:

| Level | Array shape | Chunk shape |
| --- | --- | --- |
| `r10m` | `3 × 10980 × 10980` | `1 × 366 × 366` |
| `r20m` | `3 × 5490 × 5490` | `1 × 366 × 366` |
| `r60m` | `3 × 1830 × 1830` | `1 × 366 × 366` |
| `r120m` | `3 × 915 × 915` | `1 × 305 × 305` |
| `r360m` | `3 × 305 × 305` | `1 × 305 × 305` |
| `r720m` | `3 × 153 × 153` | `1 × 153 × 153` |

- Overviews average neighbouring pixels in x/y and keep all three dates
- Each image is stored in one shard containing Blosc/Zstd-compressed chunks
- Ascending dates (UTC): 24/06/2026, 25/06/2026, 02/07/2026, with unequal gaps
- x increases across columns; y decreases down rows

## Checks and limits

Checked the metadata and read the dates and x/y coordinates at `r720m`. The server accepted a partial-file request and returned headers allowing cross-origin access.

- The third axis represents time
- Three images are enough to test loading and slicing, but we will need more to test larger volumes
- Overview metadata lives in each orbit group; root attributes are empty
- Radar values and masks have not been read yet, and browser loading has not been tested
- This is staging data and may change

## Next step

Read [ascending/r720m/vv](https://s3.explorer.eopf.copernicus.eu/esa-zarr-sentinel-explorer-fra/tests-output/sentinel-1-grd-rtc-staging/s1-rtc-32UPB.zarr/ascending/r720m/vv/zarr.json) with zarrita and check which GeoZarr utilities we can reuse.

The three images contain 70,227 values so about 0.27 MiB after decoding. At 10m resolution, the same three images take about 1.35 GiB before masks or rendering data.
