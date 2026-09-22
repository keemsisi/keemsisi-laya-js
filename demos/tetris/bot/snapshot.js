'use strict';

/* ------------------------------------------------------------------ *
 * bot/snapshot.js - the request payload sent to the decision layer.
 *
 * Translates live game state plus a shortlist into the flat object the
 * sidecar turns into a Laya prompt. This is a wire format: one reason
 * to change, and it changes in step with server/decide.mjs.
 *
 * Nothing here decides anything - it only describes.
 * ------------------------------------------------------------------ */

(function (root) {

  function createSnapshotBuilder(T, KEYS, strategies) {

    // A compact picture of the well for Laya's state. '#' filled, '.' empty.
    // Leading empty rows are dropped: they cost tokens and say nothing.
    function renderBoard() {
      const rows = [];
      let started = false;
      for (let y = 0; y < T.ROWS; y++) {
        let line = '';
        let any = false;
        for (let x = 0; x < T.COLS; x++) {
          const filled = !!T.S.board[y][x];
          if (filled) any = true;
          line += filled ? '#' : '.';
        }
        if (any) started = true;
        if (started) rows.push(line);
      }
      return rows.join('\n');          // empty string when the well is empty
    }

    function snapshot(shortlist, before) {
      const S = T.S;
      return {
        piece: S.cur ? S.cur.type : null,
        queue: S.queue.slice(0, 3),
        hold: S.hold,
        canHold: S.canHold,
        level: S.level,
        lines: S.lines,
        score: S.score,
        board: renderBoard(),
        heights: before.heights.slice(),
        maxHeight: before.maxHeight,
        holes: before.holes,
        bumpiness: before.bumpiness,
        deepestWell: before.deepestWell,
        rightColumnEmpty: before.rightColumnEmpty,
        strategies: strategies,
        candidates: shortlist.map(function (c, i) {
          return {
            key: KEYS[i], why: c.why, cleared: c.cleared,
            useHold: c.useHold, r: c.r, x: c.x, type: c.type
          };
        })
      };
    }

    return { renderBoard: renderBoard, snapshot: snapshot };
  }

  const api = { createSnapshotBuilder: createSnapshotBuilder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).snapshot = api;

})(typeof window !== 'undefined' ? window : globalThis);
