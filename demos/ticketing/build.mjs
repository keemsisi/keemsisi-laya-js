import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src/app.tsx')],
  outfile: path.join(here, 'public/app.js'),
  bundle: true,
  // IIFE, not ESM: a plain <script> works everywhere, including jsdom,
  // which cannot execute module scripts (the app integration test needs it).
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"development"' }
});
