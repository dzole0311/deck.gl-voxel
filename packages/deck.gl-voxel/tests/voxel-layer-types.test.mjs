import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageEntry = fileURLToPath(new URL('../dist/index.d.ts', import.meta.url));
const compiler = fileURLToPath(
  new URL('./bin/tsc', import.meta.resolve('typescript/package.json')),
);
const imports = `import { VoxelLayer, type VoxelData, type CellMesh, type VoxelLayerProps } from 'deck.gl-voxel';
declare const volume: VoxelData;
declare const mesh: CellMesh;
declare const palette: Uint8Array;
`;

/** Checks a temporary consumer against public declarations with the installed compiler, then removes its files. */
function diagnostics(source) {
  const directory = mkdtempSync(path.join(tmpdir(), 'voxel-layer-types-'));
  try {
    writeFileSync(path.join(directory, 'consumer.mts'), source);
    writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          types: [],
          noEmit: true,
          paths: { 'deck.gl-voxel': [packageEntry] },
        },
        include: ['consumer.mts'],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [compiler, '--project', path.join(directory, 'tsconfig.json'), '--pretty', 'false'],
      { encoding: 'utf8' },
    );
    assert.equal(result.error, undefined);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the public constructor accepts complete discriminated renderer inputs', () => {
  const source = `${imports}
new VoxelLayer({ id: 'dense', volume });
new VoxelLayer({ id: 'surface', renderMode: 'isosurface', volume, clipBounds: [0, 0, 0, 1, 1, 0.5] });
new VoxelLayer({ id: 'cells', renderMode: 'cells', mesh, palette, physicalClipBounds: [-Infinity, -Infinity, 10, Infinity, Infinity, 20] });
function inspect(props: VoxelLayerProps) {
  return props.renderMode === 'cells' ? props.mesh.count : props.volume.values.length;
}
inspect({ id: 'cells', renderMode: 'cells', mesh, palette });
`;
  const result = diagnostics(source);
  assert.equal(result.status, 0, result.output);
});

test('the public constructor rejects incomplete inputs and mixed clipping units', () => {
  const calls = [
    "new VoxelLayer({ id: 'missing-grid' })",
    "new VoxelLayer({ id: 'missing-palette', renderMode: 'cells', mesh })",
    "new VoxelLayer({ id: 'missing-mode', mesh, palette })",
    "new VoxelLayer({ id: 'mixed', renderMode: 'cells', mesh, palette, volume })",
    "new VoxelLayer({ id: 'normalized-cells', renderMode: 'cells', mesh, palette, clipBounds: [0, 0, 0, 1, 1, 1] as const })",
    "new VoxelLayer({ id: 'physical-dense', volume, physicalClipBounds: [0, 0, 0, 1, 1, 1] as const })",
    "new VoxelLayer({ id: 'unknown-mode', renderMode: 'other', volume })",
  ];
  const source =
    imports + calls.map((call, index) => `export const invalid${index} = ${call};`).join('\n');
  const result = diagnostics(source);
  assert.notEqual(result.status, 0, result.output);
  const firstInvalidLine = imports.split('\n').length;
  const rejected = new Set(
    [...result.output.matchAll(/consumer\.mts\((\d+),/g)].map(
      (match) => Number(match[1]) - firstInvalidLine,
    ),
  );
  assert.deepEqual(
    [...rejected].sort((a, b) => a - b),
    calls.map((_, index) => index),
    result.output,
  );
});
