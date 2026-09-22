'use strict';

/* ------------------------------------------------------------------ *
 * bot/overlay.js - drawing the planned placement on the board.
 *
 * The only file in bot/ that touches a canvas. One reason to change:
 * how the hint looks. Split out so the decision engine can be tested,
 * and reused headless, without a rendering context anywhere near it.
 * ------------------------------------------------------------------ */

(function (root) {

  function createOverlay(bot, deps) {
    const T = deps.T;

    function paint(ctx, CELL) {
      if (bot.mode === 'off' || !bot.plan || !T.S.cur) return;
      if (bot.plan.useHold) return;        // the hint would show the wrong piece
      const cells = bot.plan.cells;
      ctx.save();
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i][0], cy = cells[i][1];
        if (cy < 0) continue;
        ctx.strokeRect(cx * CELL + 2.5, cy * CELL + 2.5, CELL - 5, CELL - 5);
      }
      ctx.restore();
    }

    return { paint: paint };
  }

  const api = { createOverlay: createOverlay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).overlay = api;

})(typeof window !== 'undefined' ? window : globalThis);
