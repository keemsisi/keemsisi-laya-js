'use strict';

/* ------------------------------------------------------------------ *
 * bot/arbiter.js - what to do with an answer.
 *
 * Adopts the play style, gates the move on confidence, keeps the tally
 * of who actually decided each piece, and handles an answer that
 * arrived too late for the piece it was asked about.
 *
 * One reason to change: the policy for trusting the model. The request
 * itself is requester.js; carrying it out is executor.js.
 * ------------------------------------------------------------------ */

(function (root) {

  function createArbiter(bot, deps) {
    const PROFILES = deps.profiles;
    const KEYS = deps.keys;
    const replan = deps.replan;
    const floorOf = deps.confidenceFloor;   // read late: opt is mutable

    function notify(d) { if (bot.onDecision) bot.onDecision(d, bot); }

    function countEngine(d) {
      if (d.engine === 'laya') bot.stats.laya++;
      else if (d.engine === 'fallback') bot.stats.fallback++;
      else bot.stats.offline++;
    }

    // Risk and strategy are null on a move-only answer; keep the last
    // known values rather than resetting them.
    function adoptRisk(d) {
      if (typeof d.risk === 'number') { bot.risk = d.risk; bot.riskLabel = d.riskLabel; }
    }

    function adoptStrategy(d, andReplan) {
      if (!d.strategy || !PROFILES[d.strategy]) return;
      bot.strategyAge = 0;
      if (d.strategy === bot.strategy) return;
      bot.strategy = d.strategy;
      if (andReplan) replan();              // new weights, new shortlist
    }

    function applyDecision(d) {
      bot.decision = d;
      if (!d) {
        // No answer at all (sidecar down or timed out): keep the ranked
        // plan, but say so rather than silently looking like a decision.
        bot.stats.offline++;
        notify(null);
        return;
      }
      adoptStrategy(d, true);
      countEngine(d);
      adoptRisk(d);

      if (d.move === null) {
        // A play-style refresh: nothing to apply to this piece's placement.
        notify(bot.decision);
        return;
      }

      const idx = d.move ? KEYS.indexOf(d.move) : -1;
      const conf = typeof d.moveConfidence === 'number' ? d.moveConfidence : 1;
      const floor = floorOf();
      if (idx >= 0 && idx < bot.candidates.length && conf >= floor) {
        bot.plan = bot.candidates[idx];
        bot.chose = d.move;
      } else {
        // Confidence gating, as Laya's own docs recommend: an unsure
        // decision is escalated back to the deterministic ranking.
        if (idx >= 0 && conf < floor) bot.stats.overrides++;
        bot.plan = bot.candidates[0] || bot.plan;
        bot.chose = KEYS[0];
      }
      notify(bot.decision);
    }

    // A late answer is useless for the piece that has already locked, but
    // the play style it chose is not piece-specific - keep that part.
    function adoptLateStrategy(d) {
      if (!d) return;
      adoptRisk(d);
      adoptStrategy(d, false);
      notify(bot.decision);
    }

    return { applyDecision: applyDecision, adoptLateStrategy: adoptLateStrategy };
  }

  const api = { createArbiter: createArbiter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).arbiter = api;

})(typeof window !== 'undefined' ? window : globalThis);
