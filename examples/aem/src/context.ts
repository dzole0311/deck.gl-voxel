import type { Layer } from '@deck.gl/core';
import { LineLayer } from '@deck.gl/layers';
import { displayElevation } from 'deck.gl-voxel';
import type { FileMetaData } from 'hyparquet';
import type { BoreholeInterval, BoreholeLog } from './borehole.js';
import { type AemViewer, EXAGGERATION } from './viewer.js';

const MAX_LOG_INTERVALS = 4000;
const CONTEXT_URL =
  import.meta.env.VITE_AEM_CONTEXT_URL ||
  'https://huggingface.co/datasets/gjoremilevski/california-dwr-aem-context/resolve/53a7f9c2ab762bd460e90f8a0d5380663180fd28/context/';
const TEXTURES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'Top Soil': [150, 73, 5, 255],
  Clay: [50, 136, 189, 255],
  Silt: [0, 168, 132, 255],
  Sand: [255, 255, 0, 255],
  Gravel: [255, 211, 127, 255],
  Cobbles: [213, 62, 79, 255],
  Boulders: [158, 4, 18, 255],
  Rock: [219, 216, 213, 255],
};
type Position = [number, number, number];
interface Segment {
  source: Position;
  target: Position;
  color: readonly [number, number, number, number];
  tooltip: string;
  boreholeId?: string;
}
interface Well {
  log: BoreholeLog;
  intervals: BoreholeInterval[];
  segments: Segment[];
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function coordinate(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 2 && v.every(Number.isFinite);
}
async function parquet() {
  const [reader, { decompress }] = await Promise.all([import('hyparquet'), import('fzstd')]);
  const decode = (input: Uint8Array) => decompress(input);
  return { ...reader, compressors: { ZSTD: decode } };
}

async function yieldContext(): Promise<void> {
  const host = globalThis as typeof globalThis & { scheduler?: { yield(): Promise<void> } };
  if (host.scheduler?.yield) {
    await host.scheduler.yield();
  } else {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

let flights: Promise<readonly unknown[]> | undefined;
async function flightRows(): Promise<readonly unknown[]> {
  flights ??= (async () => {
    const response = await fetch(new URL('flight-paths.parquet', CONTEXT_URL));
    if (!response.ok) {
      throw new Error(`Flight paths HTTP ${response.status}`);
    }
    const file = await response.arrayBuffer();
    if (file.byteLength > 8 * 1048576) {
      throw new Error('Flight snapshot exceeds 8 MiB.');
    }
    const { parquetReadObjects, parquetMetadata, compressors } = await parquet();
    const metadata = parquetMetadata(file),
      rows: unknown[] = [];
    let start = 0;
    for (const group of metadata.row_groups) {
      const end = start + Number(group.num_rows);
      rows.push(
        ...(await parquetReadObjects({
          file,
          metadata,
          compressors,
          rowStart: start,
          rowEnd: end,
        })),
      );
      start = end;
      await yieldContext();
    }
    return rows;
  })().catch((error: unknown) => {
    flights = undefined;
    throw error;
  });
  return flights;
}

interface LogGroup {
  start: number;
  end: number;
  bounds: readonly [number, number, number, number];
}
interface LogIndex {
  file: ArrayBuffer;
  metadata: FileMetaData;
  groups: readonly LogGroup[];
}
let logs: Promise<LogIndex> | undefined;
/** Retains compressed log bytes and group bounds so only nearby complete wells need decoding. */
async function logIndex(): Promise<LogIndex> {
  logs ??= (async () => {
    const response = await fetch(new URL('logs.parquet', CONTEXT_URL));
    if (!response.ok) {
      throw new Error(`Borehole logs HTTP ${response.status}`);
    }
    const file = await response.arrayBuffer();
    if (file.byteLength > 8 * 1048576) {
      throw new Error('Log snapshot exceeds 8 MiB.');
    }
    const { parquetMetadata } = await parquet(),
      metadata = parquetMetadata(file);
    let start = 0;
    const groups = metadata.row_groups.map((group) => {
      const stat = (axis: string, kind: 'min' | 'max'): number => {
        const value = group.columns.find(
          (c) => c.meta_data?.path_in_schema.join('.') === `bbox.${axis}`,
        )?.meta_data?.statistics?.[kind];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('Log groups require numeric GeoParquet covering statistics.');
        }
        return value;
      };
      const end = start + Number(group.num_rows);
      const result: LogGroup = {
        start,
        end,
        bounds: [
          stat('xmin', 'min'),
          stat('ymin', 'min'),
          stat('xmax', 'max'),
          stat('ymax', 'max'),
        ],
      };
      start = end;
      return result;
    });
    return { file, metadata, groups };
  })().catch((error: unknown) => {
    logs = undefined;
    throw error;
  });
  return logs;
}

const logCache = new Map<number, readonly unknown[]>();
let cacheRows = 0;
async function readLogGroup(index: LogIndex, group: LogGroup): Promise<readonly unknown[]> {
  const cached = logCache.get(group.start);
  if (cached) {
    logCache.delete(group.start);
    logCache.set(group.start, cached);
    return cached;
  }
  const { parquetReadObjects, compressors } = await parquet();
  const rows: unknown[] = await parquetReadObjects({
    file: index.file,
    metadata: index.metadata,
    rowStart: group.start,
    rowEnd: group.end,
    compressors,
  });
  logCache.set(group.start, rows);
  cacheRows += rows.length;
  for (const [key, value] of logCache) {
    if (cacheRows <= 12000) {
      break;
    }
    logCache.delete(key);
    cacheRows -= value.length;
  }
  return rows;
}

/** Positions use longitude, latitude and displayed meters; buffered widths avoid unsupported WebGPU constants. */
function segmentsLayer(id: string, data: readonly Segment[], width: number): LineLayer<Segment> {
  return new LineLayer<Segment>({
    id,
    data,
    pickable: true,
    coordinateSystem: 'lnglat',
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getColor: (d) => d.color,
    getWidth: () => width,
    widthUnits: 'pixels',
    parameters: {
      depthWriteEnabled: true,
      depthCompare: 'less-equal',
      blendColorSrcFactor: 'one',
      blendColorDstFactor: 'zero',
      blendAlphaSrcFactor: 'one',
      blendAlphaDstFactor: 'zero',
    },
  });
}

/**
 * Adds flight ground footprints and complete borehole lithology intervals near the camera.
 * Caches at most 12,000 decoded rows and displays at most 4,000 intervals, preferring nearby complete wells.
 * The signal stops view updates and releases the subscription; shared snapshot reads may finish for reuse.
 */
export async function attachContext(
  viewer: AemViewer,
  options: { flights: boolean; logs: boolean; survey: string; signal: AbortSignal },
): Promise<void> {
  options.signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined,
    revision = 0;
  const refresh = async () => {
    const current = ++revision,
      layers: Layer[] = [];
    const boreholes: BoreholeLog[] = [];
    options.signal.throwIfAborted();
    const view = viewer.getView();
    const radius = Math.min(5, (360 / 2 ** view.zoom) * 3);
    const inside = (x: number, y: number) =>
      Math.abs(x - view.longitude) < radius && Math.abs(y - view.latitude) < radius;
    if (options.flights) {
      const rows = await flightRows();
      options.signal.throwIfAborted();
      const data: Segment[] = [];
      const groundAt = viewer.groundSampler();
      let deadline = performance.now() + 8;
      for (const row of rows) {
        if (performance.now() > deadline) {
          await yieldContext();
          options.signal.throwIfAborted();
          if (current !== revision) {
            return;
          }
          deadline = performance.now() + 8;
        }
        if (!record(row) || !record(row.geometry) || !Array.isArray(row.geometry.coordinates)) {
          continue;
        }
        if (
          options.survey !== 'all' &&
          (!Array.isArray(row.SurveyAreas) || !row.SurveyAreas.includes(options.survey))
        ) {
          continue;
        }
        const points = row.geometry.coordinates;
        for (let i = 1; i < points.length; i++) {
          const a = points[i - 1],
            b = points[i];
          if (!coordinate(a) || !coordinate(b) || !inside(a[0] ?? 0, a[1] ?? 0)) {
            continue;
          }
          const ax = a[0] ?? 0,
            ay = a[1] ?? 0,
            bx = b[0] ?? 0,
            by = b[1] ?? 0,
            g0 = groundAt(ax, ay),
            g1 = groundAt(bx, by);
          if (g0 === undefined || g1 === undefined) {
            continue;
          }
          data.push({
            source: [ax, ay, g0 + 1],
            target: [bx, by, g1 + 1],
            color: [35, 50, 60, 255],
            tooltip: `Flight ground footprint ${String(row.Name ?? '')} (not aircraft altitude)`,
          });
        }
      }
      layers.push(segmentsLayer('aem-flight-footprints', data, 1.5));
    }
    if (options.logs) {
      const index = await logIndex();
      options.signal.throwIfAborted();
      const nearest: { well: Well; distance: number }[] = [];
      const longitudeScale = Math.cos((view.latitude * Math.PI) / 180);
      const groups = index.groups.filter(
        (g) =>
          g.bounds[0] < view.longitude + radius &&
          g.bounds[2] > view.longitude - radius &&
          g.bounds[1] < view.latitude + radius &&
          g.bounds[3] > view.latitude - radius,
      );
      for (const group of groups) {
        const rows = await readLogGroup(index, group);
        options.signal.throwIfAborted();
        if (current !== revision) {
          return;
        }
        const wells = new Map<string, Well>();
        for (const [rowIndex, row] of rows.entries()) {
          if (!record(row) || !record(row.geometry) || !coordinate(row.geometry.coordinates)) {
            continue;
          }
          const [x = 0, y = 0] = row.geometry.coordinates,
            ground = row.GROUND_SURFACE_ELEVATION_m_y,
            top = row.LITH_TOP_DEPTH_m,
            bottom = row.LITH_BOT_DEPTH_m;
          if (
            !inside(x, y) ||
            typeof ground !== 'number' ||
            typeof top !== 'number' ||
            typeof bottom !== 'number' ||
            !Number.isFinite(ground) ||
            !Number.isFinite(top) ||
            !Number.isFinite(bottom) ||
            top < 0 ||
            bottom <= top
          ) {
            continue;
          }
          const id = String(row.WO_WID ?? row.OBJECTID),
            texture = String(row.Texture ?? 'Unknown');
          let well = wells.get(id);
          if (!well) {
            const intervals: BoreholeInterval[] = [];
            well = {
              log: { id, longitude: x, latitude: y, groundElevation: ground, intervals },
              intervals,
              segments: [],
            };
            wells.set(id, well);
          }
          const color: BoreholeInterval['color'] = TEXTURES[texture] ?? [150, 150, 150, 255];
          well.intervals.push({
            id: String(group.start + rowIndex),
            top,
            bottom,
            material: texture,
            color,
          });
          well.segments.push({
            source: [x, y, displayElevation(ground - top, ground, EXAGGERATION)],
            target: [x, y, displayElevation(ground - bottom, ground, EXAGGERATION)],
            color,
            tooltip: `Borehole ${id}: ${texture}, ${top.toFixed(1)}–${bottom.toFixed(1)} m depth; ground ${ground.toFixed(1)} m`,
            boreholeId: id,
          });
        }
        for (const well of wells.values()) {
          well.intervals.sort((a, b) => a.top - b.top || a.bottom - b.bottom);
          nearest.push({
            well,
            distance:
              ((well.log.longitude - view.longitude) * longitudeScale) ** 2 +
              (well.log.latitude - view.latitude) ** 2,
          });
        }
        nearest.sort((a, b) => a.distance - b.distance);
        let count = 0,
          kept = 0;
        for (const well of nearest) {
          if (count + well.well.segments.length <= MAX_LOG_INTERVALS) {
            nearest[kept++] = well;
            count += well.well.segments.length;
          }
        }
        nearest.length = kept;
        await yieldContext();
      }
      const data = nearest.flatMap(({ well }) => well.segments);
      boreholes.push(...nearest.map(({ well }) => well.log));
      layers.push(segmentsLayer('aem-borehole-intervals', data, 4));
    }
    if (!options.signal.aborted && current === revision) {
      viewer.setContextLayers(layers, boreholes);
    }
  };
  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch((error: unknown) => {
        if (!options.signal.aborted) {
          console.error('AEM context', error);
        }
      });
    }, 350);
  };
  const unsubscribe = viewer.subscribe(schedule);
  options.signal.addEventListener(
    'abort',
    () => {
      revision++;
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    },
    { once: true },
  );
  await refresh();
}
