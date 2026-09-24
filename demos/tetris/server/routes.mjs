/* ------------------------------------------------------------------ *
 * routes.mjs - the HTTP surface.
 *
 *   GET  /health  -> which engine is live, and how it is behaving
 *   POST /decide  -> a board snapshot becomes a typed decision
 *   POST /prompt  -> what the model would be asked (debug helper)
 *   GET  *        -> the game's static files
 *
 * One reason to change: the API. Every collaborator is injected, so
 * this maps requests onto them and does no work of its own.
 * ------------------------------------------------------------------ */

import { buildPrompt, TOKEN_BUDGET } from './decide.mjs';
import { cors, json, readBody } from './http.mjs';

export function createRouter(deps) {
  const pipeline = deps.pipeline;
  const model = deps.model;
  const scheduler = deps.scheduler;
  const keepwarm = deps.keepwarm;
  const serveStatic = deps.serveStatic;

  /** Composed from the three modules that own these facts, rather than read
   *  off one shared object: call counts belong to the scheduler, residency to
   *  keepwarm, and the checkpoint's identity to the model host. */
  function health() {
    const f = model.facts;
    const s = scheduler.stats();
    const w = keepwarm.stats();
    return {
      engine: f.state,
      model: f.modelName || (f.state === 'laya' ? 'convaiinnovations/laya (receptron/laya-onnx)' : null),
      revision: f.revision || null,
      modelDir: f.modelDir || null,
      contextTokens: f.maxLen || null,
      reason: f.reason,
      loadMs: f.loadMs,
      calls: s.calls,
      avgMs: s.avgMs,
      avgQueuedMs: s.avgQueuedMs,
      queued: s.queued,
      maxQueue: s.maxQueue,
      shed: s.shed,
      abandoned: s.abandoned,
      // Time from a request landing to its forward pass starting. Covers
      // event-loop starvation as well as waiting for the model lock.
      avgWaitMs: s.avgQueuedMs,
      warmups: w.warmups,
      lastWarmMs: w.lastWarmMs,
      keepWarm: w.keepWarm
    };
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

    if (url.pathname === '/health') return json(res, 200, health());

    if (url.pathname === '/decide') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const arrivedAt = Date.now();
      try {
        const snap = JSON.parse(await readBody(req));
        if (!snap || typeof snap !== 'object' || !Array.isArray(snap.candidates)) {
          return json(res, 400, { error: 'expected a board snapshot with a candidates array' });
        }
        // Track whether the caller is still listening, so an abandoned request
        // does not tie up the model.
        let alive = true;
        res.on('close', function () { alive = false; });
        const decision = await pipeline.decide(snap, {
          isAlive: function () { return alive; },
          arrivedAt: arrivedAt
        });
        return json(res, 200, decision);
      } catch (err) {
        return json(res, 400, { error: String(err && err.message ? err.message : err) });
      }
    }

    // Debug helper: see exactly what Laya is being asked.
    if (url.pathname === '/prompt') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      try {
        const snap = JSON.parse(await readBody(req));
        const p = buildPrompt(snap);
        return json(res, 200, {
          state: p.state, questions: p.questions,
          estimatedTokens: p.tokens, budget: TOKEN_BUDGET, trimmed: p.trimmed
        });
      } catch (err) {
        return json(res, 400, { error: String(err && err.message ? err.message : err) });
      }
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return json(res, 404, { error: 'not found' });
  };
}
