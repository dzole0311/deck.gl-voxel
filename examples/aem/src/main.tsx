import { Button } from '@deck.gl-voxel/example-ui/components/button';
import { Checkbox } from '@deck.gl-voxel/example-ui/components/checkbox';
import { Label } from '@deck.gl-voxel/example-ui/components/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@deck.gl-voxel/example-ui/components/native-select';
import type { GeoZarrCollection, GeoZarrCollectionStats } from 'deck.gl-voxel-zarr';
import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BoreholeLog } from './borehole.js';
import { BoreholePanel } from './borehole-panel.js';
import { AemViewer, type Hover, INITIAL_VIEW, SOURCE_URL } from './viewer.js';
import './style.css';

const ChunkInspector = lazy(() =>
  import('@deck.gl-voxel/example-ui/inspector').then((module) => ({
    default: module.ChunkInspector,
  })),
);
const COLORS = [
  [94, 79, 162, 255],
  [50, 136, 189, 255],
  [115, 223, 255, 255],
  [0, 168, 132, 255],
  [163, 255, 115, 255],
  [255, 255, 0, 255],
  [255, 211, 127, 255],
  [255, 170, 0, 255],
  [213, 62, 79, 255],
  [158, 1, 66, 255],
];
const SURVEY_IDS = Array.from({ length: 11 }, (_, i) => i + 1);
const PALETTE = new Uint8Array(COLORS.flat());
const PLACES: Readonly<Record<string, readonly [number, number, number]>> = {
  Kingsburg: [-119.55, 36.5, 10.8],
  Salinas: [-121.5, 36.55, 10.3],
  Sacramento: [-121.6, 38.6, 9.8],
  Overlap: [-119.68, 37.04, 12],
  Tulelake: [-121.5, 41.85, 10.4],
};

function App() {
  const [viewer, setViewer] = useState<AemViewer>();
  const [source, setSource] = useState<GeoZarrCollection>();
  const [stats, setStats] = useState<GeoZarrCollectionStats>();
  const [error, setError] = useState('');
  const [mask, setMask] = useState(1023);
  const [survey, setSurvey] = useState('all');
  const [inspector, setInspector] = useState(false);
  const [hover, setHover] = useState<Hover>();
  const [depth, setDepth] = useState(0);
  const [volumeVisible, setVolumeVisible] = useState(true);
  const [backdrop, setBackdrop] = useState(true);
  const [flights, setFlights] = useState(false);
  const [logs, setLogs] = useState(false);
  const [borehole, setBorehole] = useState<BoreholeLog>();
  useEffect(() => {
    const sourceUrl = SOURCE_URL;
    if (!sourceUrl) {
      setError('Set VITE_AEM_ZARR_URL in examples/aem/.env.local and restart the server.');
      return;
    }
    const canvas = document.querySelector<HTMLCanvasElement>('#volume');
    if (!canvas) {
      return;
    }
    const view = new AemViewer(canvas, {
      source: sourceUrl,
      palette: PALETTE,
      onHover: setHover,
      onError: (error) => setError(error.message),
      onBoreholeClick: (borehole) => {
        setBorehole(borehole);
        setInspector(false);
      },
      onSourceLoad: (reader) => {
        setSource(reader);
        setStats(reader.getStats());
        if (import.meta.env.DEV) {
          Object.assign(window, { aem: { viewer: view, source: reader } });
        }
      },
      onSourceUpdate: (reader) => setStats(reader.getStats()),
    });
    setViewer(view);
    return () => view.dispose();
  }, []);
  useEffect(() => {
    viewer?.setCategories(mask);
  }, [viewer, mask]);
  useEffect(() => {
    viewer?.setVolumeVisible(volumeVisible);
  }, [viewer, volumeVisible]);
  useEffect(() => {
    if (source) {
      viewer?.setFields(
        new Set(
          source.fields
            .filter((f) => survey === 'all' || f.attributes.survey_area_id === survey)
            .map((f) => f.path),
        ),
      );
    }
  }, [viewer, source, survey]);
  useEffect(() => {
    if (!viewer) {
      return;
    }
    if (!flights && !logs) {
      viewer.setContextLayers([]);
      return;
    }
    const controller = new AbortController();
    void import('./context.js')
      .then(({ attachContext }) => {
        if (!controller.signal.aborted) {
          return attachContext(viewer, { flights, logs, survey, signal: controller.signal });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, [viewer, flights, logs, survey]);
  const changeDepth = (value: number) => {
    setDepth(value);
    viewer?.setDepth(value);
  };
  return (
    <>
      <aside className={`controls${borehole ? ' details-open' : ''}`} aria-label="AEM controls">
        <h1>AEM GeoZarr</h1>
        <p className="subtitle">California DWR coarse fraction</p>
        <Label htmlFor="place">Location</Label>
        <NativeSelect
          id="place"
          defaultValue="Kingsburg"
          onChange={(event) => {
            const point = PLACES[event.target.value];
            if (point && viewer) {
              viewer.setView({
                ...INITIAL_VIEW,
                longitude: point[0],
                latitude: point[1],
                zoom: point[2],
              });
            }
          }}
        >
          {Object.keys(PLACES).map((name) => (
            <NativeSelectOption key={name}>{name}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Label htmlFor="survey">Surveys</Label>
        <NativeSelect
          id="survey"
          value={survey}
          onChange={(event) => setSurvey(event.target.value)}
        >
          <NativeSelectOption value="all">All available surveys</NativeSelectOption>
          {SURVEY_IDS.map((area) => (
            <NativeSelectOption key={`survey-area-${area}`} value={`survey-area-${area}`}>
              Survey Area {area}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <fieldset className="categories">
          <legend>Coarse fraction (%)</legend>
          {COLORS.map((c, i) => (
            <Label key={c.join(',')}>
              <Checkbox
                checked={Boolean(mask & (1 << i))}
                onCheckedChange={(value) => setMask((m) => (value ? m | (1 << i) : m & ~(1 << i)))}
              />
              <span
                className="swatch"
                style={{ backgroundColor: `rgb(${c[0]} ${c[1]} ${c[2]})` }}
              />
              {i * 10}–{(i + 1) * 10}
            </Label>
          ))}
        </fieldset>
        <Label htmlFor="depth">Focus below ground: {depth} m</Label>
        <input
          id="depth"
          aria-label="Focus below ground in meters"
          type="range"
          min="0"
          max="500"
          step="5"
          value={depth}
          onChange={(event) => changeDepth(Number(event.target.value))}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            viewer?.setView({ ...INITIAL_VIEW });
            changeDepth(0);
          }}
        >
          Reset view
        </Button>
        <Button variant="outline" size="sm" onClick={() => setVolumeVisible((visible) => !visible)}>
          {volumeVisible ? 'Hide volume' : 'Show volume'}
        </Button>
        <Label>
          <Checkbox
            checked={backdrop}
            onCheckedChange={(value) => {
              setBackdrop(value === true);
              viewer?.setContextVisible(value === true);
            }}
          />
          Map backdrop
        </Label>
        <Label>
          <Checkbox checked={flights} onCheckedChange={(value) => setFlights(value === true)} />
          Flight paths
        </Label>
        <Label>
          <Checkbox
            checked={logs}
            onCheckedChange={(value) => {
              setLogs(value === true);
              if (value !== true) {
                setBorehole(undefined);
              }
            }}
          />
          Borehole lithology
        </Label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setBorehole(undefined);
            setInspector((v) => !v);
          }}
        >
          Chunk inspector
        </Button>
        <p className="help">Heights are exaggerated 20× below local ground.</p>
        <p className="status" role="status">
          {!source
            ? 'Opening published GeoZarr…'
            : !volumeVisible
              ? 'Volume hidden; tile loading paused'
              : stats?.active
                ? `Refining ${stats.active} tiles (${stats.queued} remaining)`
                : `${source.getTiles().length} tiles settled`}
        </p>
        {stats ? (
          <p className="metadata">
            CPU {((stats.cacheBytes + stats.meshBytes) / 1048576).toFixed(0)} MiB |{' '}
            {stats.cacheHits} reused tiles
            {stats.budgetLimited ? ' | View exceeds cache budget' : ''}
          </p>
        ) : null}
        {error || stats?.errors.length ? (
          <p role="alert" className="error">
            {error || stats?.errors[0]}
            {stats?.errors.length
              ? ' Loaded coverage is retained; requests retry automatically.'
              : null}
          </p>
        ) : null}
        <a href="https://data.cnra.ca.gov/dataset/aem" target="_blank" rel="noreferrer">
          DWR source and documentation
        </a>
      </aside>
      {inspector && viewer ? (
        <Suspense fallback={<p className="inspector-loading">Opening inspector…</p>}>
          <ChunkInspector view={viewer} onClose={() => setInspector(false)} />
        </Suspense>
      ) : null}
      {borehole ? (
        <BoreholePanel
          key={borehole.id}
          borehole={borehole}
          onClose={() => {
            setBorehole(undefined);
            viewer?.deck.getCanvas()?.focus();
          }}
        />
      ) : null}
      {hover ? (
        <div
          role="tooltip"
          className="tooltip"
          style={{
            left: Math.min(window.innerWidth - 280, hover.x + 16),
            top: Math.max(8, hover.y - 80),
          }}
        >
          {'text' in hover ? (
            hover.text
          ) : (
            <>
              <strong>{(hover.hit.value * 100).toFixed(1)}% coarse fraction</strong>
              <br />
              {hover.tile.level === 0
                ? 'Native grid sample'
                : `Stored L${hover.tile.level} average (${250 * 2 ** hover.tile.level} Mercator units)`}
              <br />
              Elevation {hover.hit.physicalZ.toFixed(1)} m | Ground {hover.hit.groundZ.toFixed(1)} m
              <br />
              {String(hover.tile.field.attributes.title ?? hover.tile.field.path)}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing application root.');
}
createRoot(root).render(<App />);
