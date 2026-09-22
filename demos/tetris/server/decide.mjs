/* ------------------------------------------------------------------ *
 * decide.mjs - turning a Tetris position into a Laya decision.
 *
 * Laya takes a `state` (free-form text fields) and typed `questions`
 * (choice / score / noul) and answers all of them in one forward pass
 * with calibrated probabilities. Nothing here talks to the model; this
 * module is the pure translation layer, so it can be unit tested with
 * no 1.7 GB download.
 *
 * Everything here is Tetris-specific. The parts that are not - costing a
 * prompt against the context window, and reading a typed answer back out
 * of Laya's output - come from @laya-js/core.
 * ------------------------------------------------------------------ */

import {
  estimateTokenBreakdown,
  estimateContextTokens as contextTokensOf,
  readChoice,
  readScore,
  readNoul
} from '@laya-js/core';

// Kept terse on purpose: the English checkpoint has a 512-token context,
// and the move options are the last thing in the prompt - if anything is
// truncated it would be exactly the part the decision depends on.
export const STRATEGY_CRITERIA = {
  balanced: 'nothing urgent; play efficiently',
  downstack: 'cells are buried; dig them out',
  build_tetris: 'clean and low; keep the last column empty for a four-row clear',
  flatten: 'surface is jagged; even it out',
  survive: 'near the top; clear rows now at any cost'
};

export const RISK_RUBRIC = [
  'plenty of room, stack is low',
  'getting tall but still comfortable',
  'dangerous, few rows left',
  'about to top out and lose'
];

// Laya's English checkpoint: 512 tokens, and that limit is PER QUESTION.
export const CONTEXT_TOKENS = 512;
export const TOKEN_BUDGET = 440;

/**
 * Estimate the prompt cost.
 *
 * The model is @laya-js/core's: Laya encodes the whole state once per
 * question, so `usage.input_tokens` is the sum over questions while the
 * context limit applies to the largest single one. Re-exported under the
 * names this demo has always used.
 */
export function estimateTokens(state, questions) {
  return estimateTokenBreakdown(state, questions);
}

/** The largest single question, which is what the context window constrains. */
export function estimateContextTokens(state, questions) {
  return contextTokensOf(state, questions);
}

/* ------------------------------- state ---------------------------- */

export function buildState(snap, opts) {
  const o = opts || {};
  const rows = snap.rows || 20;
  const h = snap.heights || [];
  // Every character here is encoded once per question asked, so this is
  // deliberately terse: it is the single biggest lever on latency.
  const state = {
    stack:
      'Tetris well ' + (snap.cols || 10) + ' wide, ' + rows + ' tall. ' +
      'Tallest column ' + snap.maxHeight + '. ' +
      snap.holes + ' buried cell' + (snap.holes === 1 ? '' : 's') + '. ' +
      'Roughness ' + snap.bumpiness + '. Deepest gap ' + snap.deepestWell + '. ' +
      'Last column ' + (snap.rightColumnEmpty ? 'empty' : 'filled') + '.',
    columns: 'Heights: ' + h.join(',') + '.',
    pieces:
      'Falling ' + snap.piece + '. Next ' + (snap.queue || []).join(',') + '. ' +
      'Hold ' + (snap.hold || 'none') + (snap.canHold ? ' (swap ok).' : ' (swap used).')
  };

  // The ascii well is the least useful field for a text model, so it is
  // the first thing dropped when the prompt has to shrink.
  if (snap.board && /#/.test(String(snap.board)) && !o.omitWell) {
    const lines = String(snap.board).split('\n').slice(-(o.wellRows || 6));
    state.well = 'Top of the stack (# filled, . empty), lowest row last:\n' + lines.join('\n');
  }
  return state;
}

// State + questions, trimmed until they fit the context window. Returns
// what was dropped so the sidecar can say so.
export function buildPrompt(snap) {
  const questions = buildQuestions(snap);
  const trimmed = [];
  let state = buildState(snap);
  let est = estimateTokens(state, questions);
  let tokens = est.largest;

  if (tokens > TOKEN_BUDGET) {
    state = buildState(snap, { wellRows: 3 });
    trimmed.push('well shortened');
    est = estimateTokens(state, questions); tokens = est.largest;
  }
  if (tokens > TOKEN_BUDGET) {
    state = buildState(snap, { omitWell: true });
    trimmed[trimmed.length - 1] = 'well omitted';
    est = estimateTokens(state, questions); tokens = est.largest;
  }
  // Last resort: shorten the option descriptions rather than let the
  // tokenizer cut them off mid-sentence.
  for (const cap of [110, 80, 56]) {
    if (tokens <= TOKEN_BUDGET || !questions.move) break;
    let cut = false;
    for (const k of Object.keys(questions.move.criteria)) {
      const v = questions.move.criteria[k];
      if (v.length > cap) { questions.move.criteria[k] = v.slice(0, cap - 1) + '.'; cut = true; }
    }
    if (cut) trimmed.push('options shortened to ' + cap);
    est = estimateTokens(state, questions); tokens = est.largest;
  }
  return {
    state: state, questions: questions,
    tokens: tokens,                       // the largest single question
    estimatedTotal: est.total,            // what usage.input_tokens should be near
    perQuestion: est.perQuestion,
    trimmed: trimmed
  };
}

/* ----------------------------- questions -------------------------- */

export function buildQuestions(snap) {
  const criteria = {};
  (snap.candidates || []).forEach(function (c) { criteria[c.key] = c.why; });

  const allowed = snap.strategies && snap.strategies.length
    ? snap.strategies
    : Object.keys(STRATEGY_CRITERIA);
  const strategy = {};
  allowed.forEach(function (k) { if (STRATEGY_CRITERIA[k]) strategy[k] = STRATEGY_CRITERIA[k]; });

  const questions = {};

  // Each question costs a full encoder pass over the whole state, so a call
  // asks for one thing: either the move (every piece, ~0.5s) or the play
  // style and danger level (every few pieces). Bundling all three made the
  // first call ~2.3s, which then blocked the pieces behind it.
  if (snap.askStrategy === true) {
    questions.strategy = {
      type: 'choice',
      instructions: 'Which play style does this well call for right now?',
      criteria: strategy
    };
    questions.risk = {
      type: 'score',
      instructions: 'How close is this well to topping out?',
      criteria: RISK_RUBRIC
    };
    return questions;
  }

  // The actual move. Only asked when there is a real choice to make.
  if (Object.keys(criteria).length > 1) {
    questions.move = {
      type: 'choice',
      instructions:
        'Where should the falling piece go? Prefer clearing rows, ' +
        'not burying cells, and a low even stack.',
      criteria: criteria
    };
  }
  return questions;
}

/* ---------------------------- normalizing ------------------------- */

/*
 * The readers come from @laya-js/core. They are not just shorter than the
 * three this file used to carry - they are stricter in the one place it
 * matters: a reading that fell back to a default reports probability 0
 * rather than inheriting the probability of whatever option happened to
 * sit under that key. The bot gates moves on that number, so the old copy
 * could let a fallback through the confidence gate looking like a
 * high-confidence decision from the model.
 */

export function normalize(raw, snap, meta) {
  const a = (raw && raw.answers) || {};
  const keys = (snap.candidates || []).map(function (c) { return c.key; });
  const strategies = snap.strategies || Object.keys(STRATEGY_CRITERIA);

  // "Not asked" and "asked but unparseable" are different: a move-only call
  // must not silently reset the play style to the default.
  const asked = Object.keys(buildQuestions(snap));
  const strategyAsked = asked.indexOf('strategy') !== -1;
  const riskAsked = asked.indexOf('risk') !== -1;
  const moveAsked = asked.indexOf('move') !== -1;

  const strat = readChoice(a.strategy, { allowed: strategies, fallback: 'balanced' });
  const move = readChoice(a.move, { allowed: keys, fallback: keys[0] || 'a' });
  const risk = readScore(a.risk, { levels: RISK_RUBRIC, fallback: 0 });

  // Whether to swap the held piece is carried by the chosen placement
  // itself, not by a separate question that could disagree with it.
  const chosen = (snap.candidates || []).find(function (c) {
    return c.key === (keys.length > 1 ? move.value : keys[0]);
  });
  const holdP = a.use_hold ? readNoul(a.use_hold).probability : (chosen && chosen.useHold ? 1 : 0);

  return {
    engine: (meta && meta.engine) || 'laya',
    ms: (meta && meta.ms) || 0,
    model: (meta && meta.model) || (raw && raw.model) || null,
    // null means "not asked this time" - the caller keeps what it had.
    strategy: strategyAsked ? strat.value : null,
    strategyConfidence: strategyAsked ? strat.probability : null,
    strategyCertainty: strategyAsked ? strat.certainty : null,
    strategyProbabilities: strategyAsked ? strat.probabilities : null,
    risk: riskAsked ? risk.value : null,
    // readScore clamps the level into the rubric and carries the label with it.
    riskLabel: riskAsked ? risk.label : null,
    riskProbabilities: riskAsked ? (a.risk && a.risk.probabilities) || null : null,
    // null when the move was not asked on this call - the caller keeps the
    // placement it already ranked.
    move: moveAsked ? (keys.length > 1 ? move.value : (keys[0] || null)) : null,
    // The gate is the chosen option's calibrated probability, not Laya's
    // entropy-based `confidence`.
    moveConfidence: moveAsked ? (keys.length > 1 ? move.probability : 1) : null,
    moveCertainty: moveAsked ? (keys.length > 1 ? move.certainty : 1) : null,
    moveProbabilities: moveAsked ? move.probabilities : null,
    useHold: holdP >= 0.5,
    useHoldProbability: holdP,
    questionsAsked: Object.keys(buildQuestions(snap)),
    usage: (raw && raw.usage) || null
  };
}

/* ----------------------------- fallback --------------------------- */

// Used when the model is not installed, is still warming up, or errored.
// Deterministic, and always reported to the UI as engine: "fallback" so a
// Laya decision is never confused with a hand-written rule.
export function fallbackDecision(snap, meta) {
  const rows = snap.rows || 20;
  const max = snap.maxHeight || 0;
  const holes = snap.holes || 0;
  const bump = snap.bumpiness || 0;

  let risk = 0;
  if (max >= rows * 0.8) risk = 3;
  else if (max >= rows * 0.6) risk = 2;
  else if (max >= rows * 0.4) risk = 1;

  let strategy = 'balanced';
  if (risk >= 2) strategy = 'survive';
  else if (holes >= 2) strategy = 'downstack';
  else if (bump >= 12) strategy = 'flatten';
  else if (holes === 0 && max <= 8) strategy = 'build_tetris';

  const keys = (snap.candidates || []).map(function (c) { return c.key; });
  return {
    engine: (meta && meta.engine) || 'fallback',
    ms: (meta && meta.ms) || 0,
    model: null,
    reason: (meta && meta.reason) || null,
    strategy: strategy,
    strategyConfidence: 1,
    strategyCertainty: 1,
    strategyProbabilities: null,
    risk: risk,
    riskLabel: RISK_RUBRIC[risk],
    move: keys[0] || null,
    moveConfidence: 1,
    moveCertainty: 1,
    moveProbabilities: null,
    useHold: false,
    useHoldProbability: 0,
    questionsAsked: [],
    usage: null
  };
}
