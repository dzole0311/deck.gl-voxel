import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/** Serves a small generated Zarr array for inspecting real chunk requests without a remote dataset. */
export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: 'chunk-demo-store',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://localhost').pathname;
          if (!path.startsWith('/chunk-demo.zarr/')) {
            next();
            return;
          }
          response.setHeader('Cache-Control', 'no-store');
          if (path === '/chunk-demo.zarr/zarr.json') {
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({
                zarr_format: 3,
                node_type: 'array',
                shape: [4, 16, 64, 64],
                data_type: 'float32',
                dimension_names: ['time', 'z', 'y', 'x'],
                chunk_grid: { name: 'regular', configuration: { chunk_shape: [1, 4, 16, 16] } },
                chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
                codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
                fill_value: 0,
                attributes: {},
              }),
            );
            return;
          }
          const match = /^\/chunk-demo.zarr\/c\/([0-3])\/([0-3])\/([0-3])\/([0-3])$/.exec(path);
          if (!match) {
            response.statusCode = 404;
            response.end();
            return;
          }
          const time = Number(match[1]),
            cz = Number(match[2]),
            cy = Number(match[3]),
            cx = Number(match[4]);
          const values = new Float32Array(4 * 16 * 16);
          for (let z = 0; z < 4; z++) {
            for (let y = 0; y < 16; y++) {
              for (let x = 0; x < 16; x++) {
                const px = (cx * 16 + x + 0.5) / 64,
                  py = (cy * 16 + y + 0.5) / 64,
                  pz = (cz * 4 + z + 0.5) / 16;
                const wave = Math.sin(px * 13 + time * 0.7) * Math.cos(py * 11 - time * 0.4);
                const ridge = Math.exp(-((pz - 0.5 - wave * 0.2) ** 2) * 24);
                values[x + 16 * (y + 16 * z)] =
                  ridge * (0.55 + 0.45 * Math.sin(px * 5 + py * 3) ** 2);
              }
            }
          }
          response.setHeader('Content-Type', 'application/octet-stream');
          response.end(new Uint8Array(values.buffer));
        });
      },
    },
  ],
});
