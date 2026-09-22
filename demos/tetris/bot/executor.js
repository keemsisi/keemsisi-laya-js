'use strict';

/* ------------------------------------------------------------------ *
 * bot/executor.js - carrying out the chosen placement.
 *
 * Drives the game through exactly the primitives a player uses -
 * move, rotate, hold, hardDrop - and paces them off the frame clock.
 *
 * One reason to change: how a plan becomes keypresses. It reads the
 * plan and never chooses one.
 * ------------------------------------------------------------------ */

(function (root) {

  function createExecutor(bot, deps) {
    const T = deps.T;
    const opt = deps.opt;
    const replan = deps.replan;

    // Recomputed every step rather than replayed from a fixed script, so
    // gravity, a rotation kick or a blocked slide cannot desync the plan.
    function step() {
      const S = T.S;
      if (!S.cur || !bot.plan) return;

      // Derived from the plan, never a separate flag: a stale flag and a
      // fresh plan used to be able to disagree.
      if (bot.plan.useHold) {
        if (S.canHold) {
          bot.stats.holds++;
          T.holdPiece();        // spawns the swapped piece -> onPiece re-plans
          return;
        }
        replan();               // swap no longer legal; plan for this piece
        return;
      }
      if (++bot.steps > opt.maxSteps) { T.hardDrop(); return; }

      const c = S.cur;
      if (c.r !== bot.plan.r) {
        if (!T.rotate(1)) {
          // Walled in: nudge sideways and try again next step, or commit.
          if (!T.move(-1) && !T.move(1)) T.hardDrop();
        }
        return;
      }
      if (c.x !== bot.plan.x) {
        const dir = bot.plan.x > c.x ? 1 : -1;
        if (!T.move(dir)) T.hardDrop();      // path closed; take what we have
        return;
      }
      T.hardDrop();
    }

    function tick(dt) {
      if (bot.mode !== 'autoplay') return;
      if (!T.S.cur) return;

      if (bot.pending) {
        bot.waitedMs += dt;
        if (bot.waitedMs < bot.waitBudget) return;          // hold for the decision
        bot.pending = false;
        bot.stats.timeouts++;
        if (bot.onDecision) bot.onDecision(bot.decision, bot);
      }

      bot.acc += dt;
      const stepMs = Math.max(0, opt.stepMs);
      if (stepMs === 0) {                                   // instant mode
        let guard = 0;
        const piece = bot.stats.pieces;
        while (bot.stats.pieces === piece && guard++ < opt.maxSteps + 2) step();
        bot.acc = 0;
        return;
      }
      while (bot.acc >= stepMs) { bot.acc -= stepMs; step(); }
    }

    return { step: step, tick: tick };
  }

  const api = { createExecutor: createExecutor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).executor = api;

})(typeof window !== 'undefined' ? window : globalThis);
