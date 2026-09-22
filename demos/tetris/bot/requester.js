'use strict';

/* ------------------------------------------------------------------ *
 * bot/requester.js - asking the decision layer, once per piece.
 *
 * Owns everything about the in-flight call: the single-flight guard,
 * how long the piece is allowed to hover waiting for an answer, the
 * latency estimate that budget is derived from, and routing an answer
 * that arrived after its piece had already locked.
 *
 * One reason to change: the timing policy. What the answer *means* is
 * arbiter.js; what it is asked with is snapshot.js.
 * ------------------------------------------------------------------ */

(function (root) {

  function createRequester(bot, deps) {
    const T = deps.T;
    const opt = deps.opt;
    const build = deps.buildSnapshot;
    const arbiter = deps.arbiter;

    // Wait about as long as answers have actually been taking, capped so a
    // slow model never forfeits the piece to gravity.
    function budgetMs() {
      if (opt.waitForDecision) return opt.waitCapMs;
      const expected = bot.latencyMs === null ? 600 : bot.latencyMs;
      return Math.min(opt.maxWaitMs, Math.max(150, Math.min(expected * 1.4, T.gravityMs() * 0.8)));
    }

    function observeLatency(d) {
      if (!d || typeof d.ms !== 'number') return;
      bot.latencyMs = bot.latencyMs === null ? d.ms : bot.latencyMs * 0.7 + d.ms * 0.3;
    }

    function settle() { bot.pending = false; bot.inFlight = false; }

    function ask(before) {
      if (!bot.decide) { bot.decision = null; return; }

      // One request at a time: queueing a second forward pass behind the
      // first only makes both late, and the model is serialized anyway.
      if (bot.inFlight) { bot.stats.skipped++; return; }

      const snap = build(bot.candidates, before);
      // Refresh the play style periodically; ask only for the move otherwise.
      snap.askStrategy = bot.strategyAge >= opt.strategyEvery || bot.decision === null;

      bot.pending = true;
      bot.inFlight = true;
      bot.waitedMs = 0;
      bot.waitBudget = budgetMs();
      const piecesAtCall = bot.stats.pieces;

      bot.decide(snap).then(function (d) {
        settle();
        observeLatency(d);
        if (piecesAtCall !== bot.stats.pieces) { arbiter.adoptLateStrategy(d); return; }
        arbiter.applyDecision(d);
      }).catch(function () {
        settle();
        bot.stats.offline++;
        if (bot.onDecision) bot.onDecision(null, bot);
      });
    }

    return { ask: ask, budgetMs: budgetMs };
  }

  const api = { createRequester: createRequester };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).requester = api;

})(typeof window !== 'undefined' ? window : globalThis);
