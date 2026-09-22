'use strict';

/* ------------------------------------------------------------------ *
 * bot/board.js - reading a board.
 *
 * Pure functions of a board grid: geometry and the feature vector the
 * evaluation scores. One reason to change: adding or fixing a feature.
 * Nothing here knows about placements, weights, Laya or the DOM.
 * ------------------------------------------------------------------ */

(function (root) {

  // T (the game module) supplies the well's dimensions, so the same code
  // works for a non-standard board without a constant to keep in sync.
  function createBoardOps(T) {
    const COLS = T.COLS, ROWS = T.ROWS;

    function cloneBoard(b) {
      const out = new Array(b.length);
      for (let i = 0; i < b.length; i++) out[i] = b[i].slice();
      return out;
    }

    function emptyRow() { return new Array(COLS).fill(null); }

    function matrixKey(m) { return m.map(function (r) { return r.join(''); }).join('/'); }

    // The board cells a placement would occupy, in board coordinates.
    function cellsOf(pl) {
      const cells = [];
      for (let y = 0; y < pl.m.length; y++) {
        for (let x = 0; x < pl.m[y].length; x++) {
          if (pl.m[y][x]) cells.push([pl.x + x, pl.y + y]);
        }
      }
      return cells;
    }

    function colHeights(board) {
      const h = new Array(COLS).fill(0);
      for (let x = 0; x < COLS; x++) {
        for (let y = 0; y < ROWS; y++) {
          if (board[y][x]) { h[x] = ROWS - y; break; }
        }
      }
      return h;
    }

    function features(board) {
      const h = colHeights(board);
      let agg = 0, max = 0, holes = 0, bump = 0, wells = 0, deepest = 0;

      for (let x = 0; x < COLS; x++) {
        agg += h[x];
        if (h[x] > max) max = h[x];
        let seen = false;
        for (let y = 0; y < ROWS; y++) {
          if (board[y][x]) seen = true;
          else if (seen) holes++;      // empty cell with something above it
        }
      }
      for (let x = 0; x < COLS - 1; x++) bump += Math.abs(h[x] - h[x + 1]);

      // Cumulative well depth: a depth-3 well counts 1+2+3, so deep
      // single-column gaps hurt far more than shallow dips.
      for (let x = 0; x < COLS; x++) {
        const l = x === 0 ? ROWS : h[x - 1];
        const r = x === COLS - 1 ? ROWS : h[x + 1];
        const d = Math.min(l, r) - h[x];
        if (d > 0) { wells += (d * (d + 1)) / 2; if (d > deepest) deepest = d; }
      }

      // Transition counts (Dellacherie): walls and the floor count as filled.
      let rowT = 0, colT = 0;
      for (let y = 0; y < ROWS; y++) {
        let prev = 1;
        for (let x = 0; x < COLS; x++) {
          const c = board[y][x] ? 1 : 0;
          if (c !== prev) rowT++;
          prev = c;
        }
        if (prev !== 1) rowT++;
      }
      for (let x = 0; x < COLS; x++) {
        let prev = 0;
        for (let y = 0; y < ROWS; y++) {
          const c = board[y][x] ? 1 : 0;
          if (c !== prev) colT++;
          prev = c;
        }
        if (prev !== 1) colT++;
      }

      return {
        heights: h, aggHeight: agg, maxHeight: max, holes: holes,
        bumpiness: bump, wells: wells, deepestWell: deepest,
        rowTransitions: rowT, colTransitions: colT,
        rightColumnEmpty: h[COLS - 1] === 0,
        rightColumnHeight: h[COLS - 1]
      };
    }

    return {
      COLS: COLS, ROWS: ROWS,
      cloneBoard: cloneBoard, emptyRow: emptyRow, matrixKey: matrixKey,
      cellsOf: cellsOf, colHeights: colHeights, features: features
    };
  }

  const api = { createBoardOps: createBoardOps };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).board = api;

})(typeof window !== 'undefined' ? window : globalThis);
