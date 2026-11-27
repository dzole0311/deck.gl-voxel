/** One published lithology interval, measured in meters below the well's ground surface. */
export interface BoreholeInterval {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  readonly material: string;
  readonly color: readonly [number, number, number, number];
}

/** Complete intervals for a displayed well; elevations and depths retain their physical meter units. */
export interface BoreholeLog {
  readonly id: string;
  readonly longitude: number;
  readonly latitude: number;
  readonly groundElevation: number;
  readonly intervals: readonly BoreholeInterval[];
}
