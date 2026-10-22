import { builtinModules } from 'module';
import path from 'path';
import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';

import pkg from './package.json';

/**
 * One-off maintenance scripts run inside the production image, which ships `dist/` and no sources.
 * Built after the app (see the `build` script) into `dist/scripts/`, next to the locales the app copied.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  build: {
    target: 'node23',
    outDir: 'dist/scripts',
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/scripts/backfill-time-zones.ts'),
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        ...Object.keys(pkg.dependencies || {}),
        /\.node$/,
      ],
      output: { entryFileNames: 'backfill-time-zones.js', interop: 'auto', inlineDynamicImports: true },
    },
    sourcemap: true,
    // The app build wrote dist/ first; this one adds a sub-folder.
    emptyOutDir: false,
    minify: false,
  },
});
