import type { ZarrLayerSourceOptions, ZarrVoxelLayerProps } from 'deck.gl-voxel-zarr';

/** Where to load the data and how to show it on the map. */
interface Dataset {
  /** Stable layer ID and dataset selector value. */
  readonly id: string;
  /** Short description of the data shown in the panel. */
  readonly description: string;
  /** Attribution displayed in the controls. */
  readonly credit: string;

  /** Publisher's catalog or metadata link. */
  readonly source: string;

  /** Store URL or a derived-field opener managed by ZarrVoxelLayer. */
  readonly volumeSource: ZarrVoxelLayerProps['source'];

  /** Field and geometry selection for a URL-backed Zarr source. */
  readonly sourceOptions?: ZarrLayerSourceOptions;

  /** Initial map center as longitude and latitude in degrees. */
  readonly center: [number, number];

  /** Initial MapLibre zoom level. */
  readonly zoom: number;

  /** How much to stretch height on screen. A value of 1 shows the original height. */
  readonly verticalExaggeration: number;

  /** Starting density slider value. Higher values make the volume more opaque. */
  readonly density: number;

  /** Time the first frame represents, in milliseconds since the Unix epoch. */
  readonly firstTime: number;

  /** Hours between consecutive frames. */
  readonly stepHours: number;

  /** Zero-based frame shown when the dataset opens. */
  readonly initialFrame: number;

  /** Data values at the low and high ends of the color table, in the dataset's units. */
  readonly valueRange: readonly [number, number];

  /** How much one slider step changes the surface threshold, in the dataset's units. */
  readonly isovalueStep: number;

  /** Pick colors by value or by height along Z. */
  readonly colorBy: 'z' | 'value';

  /** Color and opacity table with one byte per RGBA channel. Look up opacity by data value. */
  readonly transferFunction: Uint8Array;

  /** Field name shown in the hover readout. */
  readonly valueLabel: string;

  /** Formats a scalar for the hover and isovalue readouts. */
  readonly formatValue: (value: number) => string;
}

const HELENE_URL =
  'https://helene-voxel-329134478190-eu-central-1.s3.eu-central-1.amazonaws.com/era5-helene.zarr';
const MILTON_RUN = Date.UTC(2024, 9, 8, 12);
const MILTON_STEP_HOURS = 3;

/** Volumes available in the dataset selector. */
export const datasets: Record<'helene' | 'milton', Dataset> = {
  helene: {
    id: 'helene',
    description: 'ERA5 cloud cover - September 2024',
    credit: 'Contains modified Copernicus Climate Change Service information (2024).',
    source: `${HELENE_URL}/fraction_of_cloud_cover/zarr.json`,
    volumeSource: HELENE_URL,
    sourceOptions: {
      field: 'fraction_of_cloud_cover',
      level: '2',
      verticalDimension: 'height',
      verticalCoordinates: 'height',
    },
    center: [-81, 31],
    zoom: 3.5,
    verticalExaggeration: 50,
    density: 1,
    firstTime: Date.UTC(2024, 8, 25),
    stepHours: 1,
    initialFrame: 36,
    valueRange: [0, 1],
    isovalueStep: 0.01,
    colorBy: 'z',
    transferFunction: new Uint8Array([
      68, 1, 84, 0, 59, 82, 139, 0, 33, 145, 140, 12, 94, 201, 98, 35, 253, 231, 37, 75,
    ]),
    valueLabel: 'Cloud cover',
    formatValue: (value) => `${(value * 100).toFixed(0)}%`,
  },
  milton: {
    id: 'milton',
    description: 'GFS wind speed - Run Oct 8, 12 UTC',
    credit: 'NOAA NWS NCEP GFS data via Dynamical.org (CC BY 4.0).',
    source: 'https://dynamical.org/catalog/noaa-gfs-forecast-virtual/',
    volumeSource: async (signal) => {
      const { openGfsWind } = await import('./gfs-wind.js');
      return openGfsWind(MILTON_RUN, MILTON_STEP_HOURS, signal);
    },
    center: [-87, 25],
    zoom: 5,
    verticalExaggeration: 71,
    density: 4,
    firstTime: MILTON_RUN,
    stepHours: MILTON_STEP_HOURS,
    initialFrame: 0,
    valueRange: [0, 60],
    isovalueStep: 1,
    colorBy: 'value',
    transferFunction: new Uint8Array([
      68, 1, 84, 0, 68, 57, 131, 0, 49, 104, 142, 1, 33, 145, 140, 9, 53, 183, 121, 32, 144, 215,
      67, 70, 253, 231, 37, 120,
    ]),
    valueLabel: 'Wind speed',
    formatValue: (value) => `${value.toFixed(1)} m/s`,
  },
};
