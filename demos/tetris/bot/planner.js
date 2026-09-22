'use strict';

/* ------------------------------------------------------------------ *
 * bot/planner.js - turning a search into a shortlist Laya can read.
 *
 * Ranks every placement under one profile, applies the one-piece
 * lookahead, drops near-duplicates, and writes the one-line English
 * each candidate is offered to the model with.
 *
 * One reason to change: how candidates are ordered, narrowed or
 * described. The scoring itself lives in search.js.
 * ------------------------------------------------------------------ */

(function (root) {

  const NODE = typeof module !== 'undefined' && !!module.exports;
  const boardMod = NODE ? require('./board.js') : root.TetrisBot.board;
  const searchMod = NODE ? require('./search.js') : root.TetrisBot.search;

  const ORIENT = ['flat', 'turned right', 'flipped', 'turned left'];

  function createPlanner(T, ops, search) {
    const B = ops || boardMod.createBoardOps(T);
    const S = search || searchMod.createSearch(T, B);
    const ROWS = B.ROWS;

    // Kept short deliberately: these four strings are the bulk of what is
    // sent to Laya, whose context is 512 tokens.
    function describe(cand, before) {
      const cols = cand.cells.map(function (c) { return c[0] + 1; });
      const lo = Math.min.apply(null, cols), hi = Math.max.apply(null, cols);
      const span = lo === hi ? ('col ' + lo) : ('cols ' + lo + '-' + hi);
      const newHoles = cand.f.holes - before.holes;
      const bits = [];
      bits.push(cand.type + ' ' + ORIENT[cand.r] + ' in ' + span);
      bits.push(cand.cleared === 0 ? 'clears nothing'
        : ('clears ' + cand.cleared + (cand.cleared === 1 ? ' row' : ' rows')));
      if (newHoles > 0) bits.push('buries ' + newHoles);
      else if (newHoles < 0) bits.push('frees ' + (-newHoles));
      else bits.push('buries none');
      bits.push('peak ' + cand.f.maxHeight + '/' + ROWS);
      if (cand.f.bumpiness < before.bumpiness) bits.push('flatter');
      else if (cand.f.bumpiness > before.bumpiness) bits.push('rougher');
      if (cand.f.rightColumnEmpty) bits.push('right column open');
      if (cand.useHold) bits.push('needs the hold swap');
      return bits.join(', ') + '.';
    }

    // Rank every placement for the live piece (and for the hold swap, if
    // it is available) under one weight profile.
    function rank(board, curType, swapType, W, opts) {
      const o = opts || {};
      const before = B.features(board);
      const cands = [];

      function collect(type, useHold) {
        if (!type) return;
        const list = S.placements(board, type);
        for (let i = 0; i < list.length; i++) {
          const ev = S.evaluate(board, list[i], W);
          cands.push({
            type: type, r: list[i].r, x: list[i].x, y: list[i].y, m: list[i].m,
            cells: B.cellsOf(list[i]), useHold: !!useHold,
            score: ev.score, base: ev.score, cleared: ev.cleared,
            f: ev.f, after: ev.after, topOut: ev.topOut
          });
        }
      }
      collect(curType, false);
      if (swapType && swapType !== curType) collect(swapType, true);

      cands.sort(function (a, b) { return b.score - a.score; });

      // One-piece lookahead on the shortlist: a placement that leaves the
      // well unable to take the next piece is not actually good.
      if (o.lookahead && o.nextType) {
        const depth = Math.min(cands.length, o.lookaheadWidth || 14);
        for (let i = 0; i < depth; i++) {
          const reply = S.bestReply(cands[i].after, o.nextType, W);
          cands[i].reply = reply;
          cands[i].score = cands[i].base + 0.7 * reply;
        }
        const head = cands.slice(0, depth).sort(function (a, b) { return b.score - a.score; });
        cands.length = 0;
        Array.prototype.push.apply(cands, head);
      }

      for (let i = 0; i < cands.length; i++) cands[i].why = describe(cands[i], before);
      return { before: before, candidates: cands };
    }

    // The shortlist handed to Laya: the best few *materially different*
    // placements. Near-duplicates would make the choice meaningless.
    function shortlist(cands, n) {
      const out = [], seen = {};
      for (let i = 0; i < cands.length && out.length < n; i++) {
        const k = cands[i].useHold + ':' + cands[i].r + ':' + cands[i].x;
        if (seen[k]) continue;
        seen[k] = true;
        out.push(cands[i]);
      }
      return out;
    }

    return { rank: rank, shortlist: shortlist, describe: describe };
  }

  const api = { createPlanner: createPlanner, ORIENT: ORIENT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).planner = api;

})(typeof window !== 'undefined' ? window : globalThis);
