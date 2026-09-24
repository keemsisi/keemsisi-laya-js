/* ------------------------------------------------------------------ *
 * model.mjs - hosting the checkpoint, on its own thread.
 *
 * onnxruntime-node's forward pass blocks the thread it runs on for its
 * whole duration, so the model lives in a worker and this module is the
 * only thing that talks to it. One reason to change: how the model is
 * hosted. Nothing here decides anything, schedules anything, or knows
 * what a Tetris board is.
 *
 * `facts` is deliberately only what the checkpoint itself reports -
 * which engine is live, where it came from, how big its context is.
 * Call counts, queue depth and warm-ups belong to the modules that
 * actually do those things.
 * ------------------------------------------------------------------ */

import { Worker } from 'node:worker_threads';

export function createModelHost(options) {
  const opt = options || {};
  const log = opt.log || console.log;
  const logError = opt.logError || console.error;

  const facts = {
    // 'loading' until the worker answers, then 'laya' or 'fallback'.
    state: opt.wantLaya ? 'loading' : 'fallback',
    modelDir: null,
    revision: null,
    maxLen: null,
    modelName: null,
    reason: opt.wantLaya ? null : 'started without LAYA=1, using deterministic rules',
    loadMs: 0
  };

  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function ready() {
    return facts.state === 'laya' && worker !== null;
  }

  function infer(state, questions) {
    return new Promise(function (resolve, reject) {
      if (!worker) return reject(new Error('the model worker is not running'));
      const id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      worker.postMessage({ type: 'infer', id: id, state: state, questions: questions });
    });
  }

  // Resolves either way: a checkpoint that will not load is a fallback, not
  // a crash, so the game still gets decisions from the deterministic rules.
  function load() {
    const t0 = Date.now();
    const cacheDir = process.env.LAYA_MODEL_DIR || process.env.LAYA_CACHE || '~/.cache/receptron-laya';
    log('[laya] loading weights from ' + cacheDir + ' (on a worker thread)');
    log('[laya] first run downloads ~1.7 GB (receptron/laya-onnx) and needs ~2 GB RAM');

    return new Promise(function (resolve) {
      worker = new Worker(new URL('./laya-worker.mjs', import.meta.url));
      let lastLog = 0;

      worker.on('message', function (msg) {
        if (msg.type === 'progress') {
          const now = Date.now();
          if (now - lastLog < 2000) return;            // one line every 2s, not per chunk
          lastLog = now;
          const pct = msg.total ? ' ' + Math.round((msg.received / msg.total) * 100) + '%' : '';
          log('[laya] downloading ' + msg.file + pct);
          return;
        }
        if (msg.type === 'loaded') {
          facts.state = 'laya';
          facts.loadMs = Date.now() - t0;
          facts.maxLen = msg.maxLen;
          facts.modelDir = msg.modelDir || cacheDir;
          // Reported by the worker, not echoed from the request, so health
          // states which checkpoint is resident even when the default applied.
          facts.revision = msg.revision || null;
          facts.reason = null;
          log('[laya] ready in ' + facts.loadMs + 'ms (context ' + facts.maxLen + ' tokens)');
          return resolve(facts);
        }
        if (msg.type === 'loadError') {
          facts.state = 'fallback';
          facts.reason = 'model unavailable: ' + msg.error;
          logError('[laya] ' + facts.reason);
          logError('[laya] falling back to deterministic rules. Install with: npm install (at the repo root)');
          return resolve(facts);
        }
        if (msg.type === 'result' || msg.type === 'error') {
          const p = pending.get(msg.id);
          if (!p) return;                              // the caller already gave up
          pending.delete(msg.id);
          if (msg.type === 'result') p.resolve(msg.result);
          else p.reject(new Error(msg.error));
        }
      });

      worker.on('error', function (err) {
        facts.state = 'fallback';
        facts.reason = 'model worker crashed: ' + err.message;
        logError('[laya] ' + facts.reason);
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        resolve(facts);
      });

      worker.postMessage({
        type: 'load',
        modelDir: process.env.LAYA_MODEL_DIR || null,
        cacheDir: process.env.LAYA_CACHE || null,
        // Left undefined rather than null: @laya-js/server defaults this to
        // the verified checkpoint, and null would mean "no pin".
        revision: process.env.LAYA_REVISION || undefined
      });
    });
  }

  async function close() {
    if (!worker) return;
    try { await worker.terminate(); } catch { /* shutting down anyway */ }
    worker = null;
  }

  // The id the checkpoint reported on its last answer, so a stub cannot
  // inherit a hardcoded name.
  function observeModelName(raw) {
    if (raw && typeof raw.model === 'string') facts.modelName = raw.model;
  }

  return { facts, ready, infer, load, close, observeModelName };
}
