import { Button } from '@deck.gl-voxel/example-ui/components/button';
import { useEffect, useRef } from 'react';
import type { BoreholeLog } from './borehole.js';

/** Displays physical depths alongside a proportional lithology column using the map's colors. */
export function BoreholePanel({
  borehole,
  onClose,
}: {
  readonly borehole: BoreholeLog;
  readonly onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const depth = Math.max(...borehole.intervals.map((interval) => interval.bottom));
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <aside
      className="borehole-details"
      aria-labelledby="borehole-heading"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="borehole-header">
        <h2 id="borehole-heading" ref={heading} tabIndex={-1}>
          Borehole {borehole.id}
        </h2>
        <Button variant="outline" size="sm" aria-label="Close borehole details" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="metadata">
        {borehole.latitude.toFixed(4)}, {borehole.longitude.toFixed(4)}
      </p>
      <dl className="borehole-summary">
        <div>
          <dt>Ground elevation</dt>
          <dd>{borehole.groundElevation.toFixed(1)} m</dd>
        </div>
        <div>
          <dt>Logged depth</dt>
          <dd>{depth.toFixed(1)} m</dd>
        </div>
      </dl>
      <div className="borehole-log">
        <div className="borehole-column" aria-hidden="true">
          <span>0 m</span>
          <svg viewBox="0 0 48 320" preserveAspectRatio="none" aria-hidden="true">
            {borehole.intervals.map((interval) => (
              <rect
                key={interval.id}
                x="0"
                y={(interval.top / depth) * 320}
                width="48"
                height={((interval.bottom - interval.top) / depth) * 320}
                fill={`rgb(${interval.color[0]} ${interval.color[1]} ${interval.color[2]})`}
              />
            ))}
          </svg>
          <span>{depth.toFixed(1)} m</span>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the interval table. */}
        <section className="borehole-intervals" tabIndex={0} aria-label="Lithology intervals">
          <table>
            <caption>Lithology</caption>
            <thead>
              <tr>
                <th scope="col">Depth (m)</th>
                <th scope="col">Material</th>
              </tr>
            </thead>
            <tbody>
              {borehole.intervals.map((interval) => (
                <tr key={interval.id}>
                  <td>
                    {interval.top.toFixed(1)}–{interval.bottom.toFixed(1)}
                  </td>
                  <td>
                    <span
                      className="borehole-swatch"
                      style={{
                        backgroundColor: `rgb(${interval.color[0]} ${interval.color[1]} ${interval.color[2]})`,
                      }}
                    />
                    {interval.material}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </aside>
  );
}
