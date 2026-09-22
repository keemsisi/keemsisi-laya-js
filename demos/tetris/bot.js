'use strict';

/* ------------------------------------------------------------------ *
 * bot.js - the spatial half of the decision engine.
 *
 * Laya is a text decision model: it cannot see a board or search a
 * game tree. So this half does the part Laya cannot do -
 *
 *   1. enumerate every placement the current piece can legally reach
 *      (rotate at spawn, slide, drop - the same moves a player has),
 *   2. score each one with a weighted feature evaluation,
 *   3. shortlist the best few and describe them in plain English,
 *   4. execute the chosen placement through the normal primitives.
 *
 * Laya then does the part a heuristic is bad at: choosing *which*
 * shortlisted move to play and *which* weight profile (play style)
 * the situation calls for. See laya-client.js and server/decide.mjs.
 *
 * This file is the composition root and nothing else. Each step above
 * lives in its own module under bot/, and is wired together here:
 *
 *   profiles   the weight profiles                 (data)
 *   board      reading a board                     (pure)
 *   search     reachable placements, simulation    (pure)
 *   planner    ranking, shortlisting, describing   (pure)
 *   snapshot   the request payload                 (wire format)
 *   requester  the in-flight call and its budget   (timing)
 *   arbiter    what an answer is allowed to change (policy)
 *   executor   plan -> keypresses                  (game I/O)
 *   overlay    drawing the plan                    (canvas)
 *
 * The browser loads them as plain scripts in that order; Node requires
 * them. Both reach the same objects.
 * ------------------------------------------------------------------ */

(function (root) {

  const NODE = typeof module !== 'undefined' && !!module.exports;
  function need(name) {
    return NODE ? require('./bot/' + name + '.js') : root.TetrisBot[name];
  }

  const profilesMod = need('profiles');
  const boardMod = need('board');
  const searchMod = need('search');
  const plannerMod = need('planner');
  const snapshotMod = need('snapshot');
  const requesterMod = need('requester');
  const arbiterMod = need('arbiter');
  const executorMod = need('executor');
  const overlayMod = need('overlay');

  const PROFILES = profilesMod.PROFILES;
  const STRATEGIES = profilesMod.STRATEGIES;
  const KEYS = 'abcdefgh';

  /* --------------------- the spatial reasoning ------------------- */

  // One flat facade over board + search + planner. Kept flat because it
  // is a published surface: the tests and the sidecar's prompt builder
  // both reach for core.rank / core.evaluate / core.features by name.
  function makeCore(T) {
    const board = boardMod.createBoardOps(T);
    const search = searchMod.createSearch(T, board);
    const planner = plannerMod.createPlanner(T, board, search);

    return {
      cloneBoard: board.cloneBoard,
      colHeights: board.colHeights,
      features: board.features,
      cellsOf: board.cellsOf,
      placements: search.placements,
      applyPlacement: search.applyPlacement,
      evaluate: search.evaluate,
      bestReply: search.bestReply,
      rank: planner.rank,
      shortlist: planner.shortlist,
      describe: planner.describe,
      PROFILES: PROFILES,
      STRATEGIES: STRATEGIES
    };
  }

  /* ------------------------- the controller ---------------------- */

  function createBot(T, cfg) {
    const core = makeCore(T);
    const opt = Object.assign({
      shortlist: 4,
      lookahead: true,
      lookaheadWidth: 14,
      stepMs: 55,
      confidenceFloor: 0.34,   // below this, keep the heuristic pick
      maxSteps: 28,
      // Laya re-encodes the whole board for every question asked, so the
      // play style and risk are refreshed periodically while the move is
      // asked every piece. Measured: move alone ~400ms, all three ~2.6s.
      strategyEvery: 6,
      maxWaitMs: 900,
      // Hold the piece until the model answers, however long it takes, so
      // every placement is Laya's. Costs wall-clock; buys a game that is
      // genuinely model-driven rather than mostly heuristic.
      waitForDecision: false,
      waitCapMs: 8000
    }, cfg || {});

    const bot = {
      core: core,
      opt: opt,
      mode: 'off',            // 'off' | 'assist' | 'autoplay'
      strategy: 'balanced',
      decide: null,           // async (snapshot) => decision, injected
      onDecision: null,       // UI callback
      decision: null,
      candidates: [],
      plan: null,
      risk: null,
      riskLabel: null,
      pending: false,
      inFlight: false,
      latencyMs: null,        // exponential moving average of answer latency
      strategyAge: 99,        // pieces since the play style was last refreshed
      waitedMs: 0,
      waitBudget: 0,
      acc: 0,
      steps: 0,
      stats: { pieces: 0, laya: 0, fallback: 0, offline: 0, timeouts: 0, overrides: 0, holds: 0, skipped: 0 }
    };

    function replan() {
      const S = T.S;
      if (!S.cur) { bot.plan = null; bot.candidates = []; return null; }
      const W = PROFILES[bot.strategy] || PROFILES.balanced;
      const swap = S.canHold ? (S.hold || S.queue[0]) : null;
      const r = core.rank(S.board, S.cur.type, swap, W, {
        lookahead: opt.lookahead,
        lookaheadWidth: opt.lookaheadWidth,
        nextType: S.queue[0]
      });
      bot.candidates = core.shortlist(r.candidates, opt.shortlist);
      bot.plan = bot.candidates[0] || null;
      bot.before = r.before;
      return r;
    }

    const snapshots = snapshotMod.createSnapshotBuilder(T, KEYS, STRATEGIES);
    const arbiter = arbiterMod.createArbiter(bot, {
      profiles: PROFILES,
      keys: KEYS,
      replan: replan,
      confidenceFloor: function () { return opt.confidenceFloor; }
    });
    const requester = requesterMod.createRequester(bot, {
      T: T, opt: opt, buildSnapshot: snapshots.snapshot, arbiter: arbiter
    });
    const executor = executorMod.createExecutor(bot, { T: T, opt: opt, replan: replan });
    const overlay = overlayMod.createOverlay(bot, { T: T });

    function onPiece() {
      bot.stats.pieces++;
      bot.strategyAge++;
      bot.steps = 0;
      bot.acc = 0;
      bot.chose = null;
      if (bot.mode === 'off') { bot.plan = null; bot.candidates = []; return; }

      const r = replan();
      if (!r || !bot.candidates.length) return;

      requester.ask(r.before);
    }

    bot.replan = replan;
    bot.applyDecision = arbiter.applyDecision;
    bot.onPiece = onPiece;
    bot.step = executor.step;
    bot.tick = executor.tick;
    bot.paint = overlay.paint;
    bot.snapshot = snapshots.snapshot;
    bot.setMode = function (m) {
      bot.mode = m;
      if (m === 'off') { bot.plan = null; bot.candidates = []; bot.decision = null; bot.strategyAge = 99; }
      else if (T.S.cur) onPiece();
    };
    bot.attach = function () {
      T.hooks.piece = onPiece;
      T.hooks.frame = executor.tick;
      T.setOverlayPainter(overlay.paint);
    };
    return bot;
  }

  const api = { makeCore: makeCore, createBot: createBot, PROFILES: PROFILES, STRATEGIES: STRATEGIES, KEYS: KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TetrisBotCore = api;

})(typeof window !== 'undefined' ? window : globalThis);
