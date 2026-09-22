import type { Questions, State } from './types.js';

/**
 * Context budgeting.
 *
 * Laya's English checkpoint has a 512-token window and the multilingual one
 * 1024. Questions are serialized after the state, so an oversized prompt
 * loses the options the decision depends on - silently. This estimates the
 * size and trims in an order the caller controls, so what gets dropped is a
 * decision rather than an accident.
 */

export const CONTEXT_TOKENS = {
  /** convaiinnovations/laya, ModernBERT-large backbone. */
  english: 512,
  /** mmBERT-base variant, `subfolder: "multilingual"`. */
  multilingual: 1024
} as const;

/**
 * Leave room for the tokenizer's own framing; 85% of the window is safe.
 *
 * This is a PER-QUESTION budget. Laya encodes the whole state once per
 * question, so the context window constrains the largest single question,
 * not the sum across a batch.
 */
export function defaultBudget(context: keyof typeof CONTEXT_TOKENS = 'english'): number {
  return Math.floor(CONTEXT_TOKENS[context] * 0.85);
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export interface TokenEstimate {
  /** Sum over questions - what `usage.input_tokens` reports. */
  total: number;
  /** Cost of each question on its own. */
  perQuestion: Record<string, number>;
  /** The largest single question: the figure the context window limits. */
  largest: number;
}

function stateChars(state: State): number {
  if (typeof state === 'string') return state.length;
  let chars = 0;
  for (const k of Object.keys(state ?? {})) chars += k.length + textOf(state[k]).length;
  return chars;
}

/**
 * Estimate prompt cost, per question.
 *
 * Laya encodes the whole state once per question - each question is its own
 * sequence in the batch - so cost scales with questions x state size, and
 * the 512-token window applies to the largest single question rather than
 * to the sum. Verified on convaiinnovations/laya: token counts scaled
 * exactly 1x/2x/3x with 1/2/3 questions over an identical state.
 *
 * Fitted against measured `usage.input_tokens` on that checkpoint:
 *
 *   perQuestion ~= 1.2 * ( chars/4 + 3.75 * options + 12 )
 *
 * The 1.2 is deliberate headroom: the raw fit sat ~15% under the measured
 * totals, and under-estimating is the dangerous direction.
 */
export function estimateTokenBreakdown(state: State, questions: Questions): TokenEstimate {
  const base = stateChars(state);
  const perQuestion: Record<string, number> = {};
  let total = 0;
  let largest = 0;

  for (const key of Object.keys(questions ?? {})) {
    const q = questions[key]!;
    let chars = base + key.length + textOf(q.instructions).length;
    let options = 2;                       // a noul scores true/false
    const c = (q as { criteria?: unknown }).criteria;
    if (Array.isArray(c)) {
      options = c.length;
      for (const x of c) chars += textOf(x).length;
    } else if (c && typeof c === 'object') {
      const keys = Object.keys(c as Record<string, unknown>);
      options = keys.length;
      for (const k of keys) chars += k.length + textOf((c as Record<string, unknown>)[k]).length;
    }
    const t = Math.ceil(1.2 * (chars / 4 + 3.75 * options + 12));
    perQuestion[key] = t;
    total += t;
    if (t > largest) largest = t;
  }
  return { total, perQuestion, largest };
}

/** Total cost across the batch, comparable to `usage.input_tokens`. */
export function estimateTokens(state: State, questions: Questions): number {
  return estimateTokenBreakdown(state, questions).total;
}

/** The largest single question - the figure the context window constrains. */
export function estimateContextTokens(state: State, questions: Questions): number {
  return estimateTokenBreakdown(state, questions).largest;
}

export interface FitOptions {
  budget?: number;
  /** State keys to drop, in order, when over budget. Least useful first. */
  dropStateKeys?: readonly string[];
  /** Question whose option descriptions may be shortened as a last resort. */
  shortenQuestion?: string;
  /** Successive character caps applied to those descriptions. */
  caps?: readonly number[];
}

export interface FitResult {
  state: State;
  questions: Questions;
  /** The largest single question, which is what has to fit the window. */
  tokens: number;
  /** Sum across questions, comparable to `usage.input_tokens`. */
  total: number;
  /** What was given up, in the order it happened. Empty when nothing was. */
  trimmed: string[];
  /** True when even the last resort left it over budget. */
  overBudget: boolean;
}

/** Trim a prompt until it fits. Never mutates its arguments. */
export function fitToContext(state: State, questions: Questions, opts: FitOptions = {}): FitResult {
  const budget = opts.budget ?? defaultBudget();
  const caps = opts.caps ?? [160, 110, 80, 56];
  const trimmed: string[] = [];

  let nextState: State =
    typeof state === 'string' ? state : { ...(state as Record<string, unknown>) };
  const nextQuestions: Questions = {};
  for (const k of Object.keys(questions)) {
    const q = questions[k]!;
    const c = (q as { criteria?: unknown }).criteria;
    nextQuestions[k] = {
      ...q,
      ...(Array.isArray(c) ? { criteria: [...c] } : c && typeof c === 'object' ? { criteria: { ...(c as object) } } : {})
    } as Questions[string];
  }

  let est = estimateTokenBreakdown(nextState, nextQuestions);
  let tokens = est.largest;
  if (tokens <= budget) {
    return { state: nextState, questions: nextQuestions, tokens, total: est.total, trimmed, overBudget: false };
  }

  for (const key of opts.dropStateKeys ?? []) {
    if (tokens <= budget) break;
    if (typeof nextState === 'string') break;
    if (!(key in (nextState as Record<string, unknown>))) continue;
    delete (nextState as Record<string, unknown>)[key];
    trimmed.push(`state.${key} dropped`);
    est = estimateTokenBreakdown(nextState, nextQuestions); tokens = est.largest;
  }

  const target = opts.shortenQuestion ? nextQuestions[opts.shortenQuestion] : undefined;
  const criteria = target ? (target as { criteria?: unknown }).criteria : undefined;
  if (criteria && typeof criteria === 'object' && !Array.isArray(criteria)) {
    const rec = criteria as Record<string, string | null>;
    for (const cap of caps) {
      if (tokens <= budget) break;
      let cut = false;
      for (const k of Object.keys(rec)) {
        const v = rec[k];
        if (typeof v === 'string' && v.length > cap) { rec[k] = v.slice(0, Math.max(1, cap - 1)) + '…'; cut = true; }
      }
      if (cut) {
        trimmed.push(`${opts.shortenQuestion} options shortened to ${cap}`);
        est = estimateTokenBreakdown(nextState, nextQuestions); tokens = est.largest;
      }
    }
  }

  return { state: nextState, questions: nextQuestions, tokens, total: est.total, trimmed, overBudget: tokens > budget };
}
