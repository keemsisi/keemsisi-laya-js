'use strict';

/* ------------------------------------------------------------------ *
 * bot/search.js - enumerating and simulating placements.
 *
 * What the current piece can legally reach, what the board looks like
 * afterwards, and what that is worth under one weight profile.
 *
 * One reason to change: the move model (which placements are reachable)
 * or the scoring terms. Board reading lives in board.js; which profile
 * to use is decided elsewhere.
 * ------------------------------------------------------------------ */

(function (root) {

  const NODE = typeof module !== 'undefined' && !!module.exports;
  const boardMod = NODE ? require('./board.js') : root.TetrisBot.board;

  function createSearch(T, ops) {
    const B = ops || boardMod.createBoardOps(T);
    const COLS = B.COLS, ROWS = B.ROWS;

    // Every placement reachable by: rotate at the spawn row, slide
    // sideways, drop. No tucks or spins - exactly what the executor
    // can actually reproduce with move/rotate/hardDrop.
    function placements(board, type) {
      const out = [];
      let p = { type: type, m: T.clone(T.SHAPES[type]), x: T.SPAWN_X[type], y: 0, r: 0 };
      if (T.collidesOn(board, p.m, p.x, p.y)) return out;   // already topped out

      // Two rotation states can land on identical cells (an I or S or Z
      // sits in a different row of its bounding box at r0 and r2). Key on
      // the landed footprint so each distinct move is offered once.
      const seenShape = {};
      const seenLanding = {};
      for (let k = 0; k < 4; k++) {
        if (k > 0) {
          const np = T.rotatedPiece(board, p, 1);
          if (!np) break;                                   // rotation walled in
          p = np;
        }
        const key = B.matrixKey(p.m);
        if (seenShape[key]) continue;                       // O repeats its shape
        seenShape[key] = true;

        const xs = [p.x];
        for (let x = p.x - 1; x >= -3; x--) {
          if (T.collidesOn(board, p.m, x, p.y)) break;
          xs.push(x);
        }
        for (let x = p.x + 1; x <= COLS + 3; x++) {
          if (T.collidesOn(board, p.m, x, p.y)) break;
          xs.push(x);
        }

        for (let i = 0; i < xs.length; i++) {
          let y = p.y;
          while (!T.collidesOn(board, p.m, xs[i], y + 1)) y++;
          const pl = { type: type, m: p.m, r: p.r, x: xs[i], y: y };
          const land = B.cellsOf(pl).sort().join(';');
          if (seenLanding[land]) continue;
          seenLanding[land] = true;
          out.push(pl);
        }
      }
      return out;
    }

    // Drop the piece onto a copy of the board and resolve line clears.
    function applyPlacement(board, pl) {
      const b = B.cloneBoard(board);
      const cells = B.cellsOf(pl);
      let topOut = false;
      for (let i = 0; i < cells.length; i++) {
        const cx = cells[i][0], cy = cells[i][1];
        if (cy < 0) { topOut = true; continue; }            // locked above the well
        b[cy][cx] = pl.type;
      }

      const clearedRows = [];
      for (let y = 0; y < ROWS; y++) {
        let full = true;
        for (let x = 0; x < COLS; x++) if (!b[y][x]) { full = false; break; }
        if (full) clearedRows.push(y);
      }
      // Rebuild rather than splice: removing a row shifts the rows above
      // it, so a list of row indices goes stale after the first removal.
      if (clearedRows.length) {
        const kept = [];
        for (let y = 0; y < ROWS; y++) {
          if (clearedRows.indexOf(y) === -1) kept.push(b[y]);
        }
        while (kept.length < ROWS) kept.unshift(B.emptyRow());
        for (let y = 0; y < ROWS; y++) b[y] = kept[y];
      }

      // Dellacherie's "eroded piece cells": rows cleared x how many of
      // the cleared cells belonged to this piece. Rewards clears the
      // piece actually paid for.
      let own = 0;
      for (let i = 0; i < cells.length; i++) {
        if (clearedRows.indexOf(cells[i][1]) !== -1) own++;
      }

      let bottom = -1;
      for (let i = 0; i < cells.length; i++) if (cells[i][1] > bottom) bottom = cells[i][1];

      return {
        board: b,
        cleared: clearedRows.length,
        eroded: clearedRows.length * own,
        landingHeight: ROWS - bottom,
        topOut: topOut
      };
    }

    function evaluate(board, pl, W) {
      const r = applyPlacement(board, pl);
      const f = B.features(r.board);
      let s = 0;
      s += W.lineScore[r.cleared];
      s += W.eroded * r.eroded;
      s += W.landingHeight * r.landingHeight;
      s += W.holes * f.holes;
      s += W.rowTransitions * f.rowTransitions;
      s += W.colTransitions * f.colTransitions;
      s += W.wells * f.wells;
      s += W.maxHeight * f.maxHeight;
      s += W.bumpiness * f.bumpiness;
      s += W.aggHeight * f.aggHeight;
      if (W.rightColumnOpen) s += W.rightColumnOpen * (f.rightColumnEmpty ? 1 : 0);
      if (r.topOut) s -= 1e6;                               // never choose to die
      return { score: s, cleared: r.cleared, after: r.board, f: f, topOut: r.topOut };
    }

    // Best achievable score for `type` on `board` - the lookahead term.
    function bestReply(board, type, W) {
      const list = placements(board, type);
      let best = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const s = evaluate(board, list[i], W).score;
        if (s > best) best = s;
      }
      return best === -Infinity ? -1e6 : best;
    }

    return {
      placements: placements, applyPlacement: applyPlacement,
      evaluate: evaluate, bestReply: bestReply
    };
  }

  const api = { createSearch: createSearch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).search = api;

})(typeof window !== 'undefined' ? window : globalThis);
