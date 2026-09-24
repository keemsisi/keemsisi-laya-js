/* ------------------------------------------------------------------ *
 * server.mjs - the Laya sidecar.
 *
 * Laya runs on ONNX Runtime in Node and its weights are ~1.7 GB, so it
 * cannot run in the browser. This process holds the model, serves the
 * game's static files, and exposes one endpoint the game calls once per
 * piece:
 *
 *   GET  /health  -> which engine is live
 *   POST /decide  -> { ...board snapshot } -> a typed decision
 *
 * Start in fallback mode (no model, deterministic rules):
 *   node server/server.mjs
 * Start with the real model (downloads ~1.7 GB on first run):
 *   LAYA=1 node server/server.mjs
 *
 * This file is the composition root and nothing else. Each concern has
 * its own module, wired together below:
 *
 *   model.mjs      hosting the checkpoint on a worker thread
 *   scheduler.mjs  one pass at a time, and who gets refused
 *   keepwarm.mjs   keeping the weights resident
 *   pipeline.mjs   snapshot -> decision, model or deterministic rules
 *   routes.mjs     the HTTP surface
 *   http.mjs       CORS, JSON, capped body reads, static files
 *   decide.mjs     board <-> prompt translation (Tetris-specific)
 * ------------------------------------------------------------------ */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModelHost } from './model.mjs';
import { createScheduler } from './scheduler.mjs';
import { createKeepWarm } from './keepwarm.mjs';
import { createPipeline } from './pipeline.mjs';
import { createRouter } from './routes.mjs';
import { createStaticServer } from './http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 8787);
// Loopback only by default: the sidecar answers with no authentication, so
// it should not be reachable from the network unless that is asked for.
const HOST = process.env.HOST || '127.0.0.1';
const WANT_LAYA = process.env.LAYA === '1' || process.argv.includes('--laya');

const model = createModelHost({ wantLaya: WANT_LAYA });

// How many callers may wait for the lock. A game asks once per piece, so a
// backlog means the model is already behind; queueing more only makes every
// answer later than the last. Shed instead.
const scheduler = createScheduler({
  maxQueue: Number(process.env.LAYA_MAX_QUEUE || 1)
});

const keepwarm = createKeepWarm({
  intervalMs: Number(process.env.LAYA_KEEPWARM_MS || 20000),
  rounds: Number(process.env.LAYA_KEEPWARM_ROUNDS || 9),
  ready: model.ready,
  busy: scheduler.busy,
  // A warming pass is the smallest question the model will answer; it exists
  // only to touch the weights, so it goes through the same lock as real work.
  warm: async function () {
    const r = await scheduler.run(function () {
      return model.infer(
        { s: 'idle' },
        { warm: { type: 'choice', instructions: 'keep resident', criteria: { a: 'one', b: 'two' } } }
      );
    }, {});
    if (!r.ok) throw new Error(r.reason);
  }
});

const pipeline = createPipeline({ model, scheduler, keepwarm });

const server = http.createServer(createRouter({
  pipeline, model, scheduler, keepwarm,
  serveStatic: createStaticServer(ROOT)
}));

// A bound port used to kill the process with no explanation; say so instead.
server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('[server] port ' + PORT + ' is already in use.');
    console.error('[server] pick another with: PORT=8788 node server/server.mjs');
  } else {
    console.error('[server] ' + (err && err.message ? err.message : String(err)));
  }
  process.exit(1);
});

// PORT=0 asks the OS for a free port, so report what we actually got.
server.listen(PORT, HOST, async function () {
  const addr = server.address();
  const loopback = addr.address === '127.0.0.1' || addr.address === '::1';
  console.log('Tetris + Laya decision engine');
  console.log('  game    http://localhost:' + addr.port + '/');
  console.log('  health  http://localhost:' + addr.port + '/health');
  console.log('  bound   ' + addr.address + ':' + addr.port +
              (loopback ? ' (this machine only)' : ' (REACHABLE FROM THE NETWORK)'));
  console.log('  engine  ' + (WANT_LAYA ? 'laya (loading)' : 'fallback (run with LAYA=1 for the real model)'));
  if (!loopback) {
    console.warn('  warning: /decide has no authentication; bound beyond loopback by HOST=' + HOST);
  }
  if (WANT_LAYA) {
    await model.load();
    keepwarm.schedule();
  }
});

process.on('SIGINT', async function () {
  keepwarm.stop();
  await model.close();
  process.exit(0);
});
