import { optionsOf } from './questions.js';
import type { ChoiceQuestion, NoulQuestion, Question, Questions, ScoreQuestion } from './types.js';

/**
 * Reading answers defensively.
 *
 * A decision model's output drives real branching, so a missing field or an
 * option the model invented must not become a thrown exception three layers
 * up. Every reader returns a usable value and says whether it had to fall
 * back.
 */

export interface ChoiceReading {
  kind: 'choice';
  /** The chosen option. */
  value: string;
  /**
   * Calibrated probability of `value`. This is the number to threshold on -
   * NOT `certainty`, which is an entropy measure over the whole distribution.
   */
  probability: number;
  /** Laya's own `confidence`: 1 - normalized entropy of the distribution. */
  certainty: number;
  probabilities: Record<string, number> | null;
  /** The answer was absent, malformed, or named an option that wasn't offered. */
  fallback: boolean;
}

export interface ScoreReading {
  kind: 'score';
  /** Expected level, fractional, 0 .. levels-1. */
  value: number;
  /** Nearest rubric level, when levels were supplied. */
  label: string | null;
  /** `value` rounded to an integer level. */
  level: number;
  probabilities: Record<string, number> | null;
  fallback: boolean;
}

export interface NoulReading {
  kind: 'noul';
  /** P(true). */
  probability: number;
  isTrue: boolean;
  fallback: boolean;
}

export type Reading = ChoiceReading | ScoreReading | NoulReading;

/**
 * The reading a given question produces.
 *
 * Without this, every reading is the union and callers have to narrow by
 * `kind` before touching `.value` - which defeats the point of knowing the
 * question type at the call site.
 */
export type ReadingFor<Q extends Question> =
  Q extends ChoiceQuestion ? ChoiceReading :
  Q extends ScoreQuestion ? ScoreReading :
  Q extends NoulQuestion ? NoulReading :
  Reading;

/** Readings for a whole question map, each typed by its question. */
export type ReadingsFor<Q extends Questions> = { [K in keyof Q]: ReadingFor<Q[K]> };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function numberMap(v: unknown): Record<string, number> | null {
  const r = asRecord(v);
  if (!r) return null;
  const out: Record<string, number> = {};
  let any = false;
  for (const k of Object.keys(r)) {
    const n = r[k];
    if (typeof n === 'number' && Number.isFinite(n)) { out[k] = n; any = true; }
  }
  return any ? out : null;
}

function argmax(probs: Record<string, number>): string | null {
  let best: string | null = null;
  for (const k of Object.keys(probs)) if (best === null || probs[k]! > probs[best]!) best = k;
  return best;
}

export function readChoice(
  answer: unknown,
  opts: { allowed?: readonly string[]; fallback?: string } = {}
): ChoiceReading {
  const a = asRecord(answer);
  const allowed = opts.allowed;
  const fallbackValue = opts.fallback ?? (allowed && allowed.length ? allowed[0]! : '');
  const probabilities = a ? numberMap(a['probabilities'] ?? a['probs']) : null;

  let value: string | null = null;
  if (a) {
    const raw = a['choice'] ?? a['label'] ?? a['answer'];
    if (typeof raw === 'string') value = raw;
  }
  if (value === null && probabilities) value = argmax(probabilities);

  let fallback = false;
  if (value === null || (allowed && !allowed.includes(value))) {
    value = fallbackValue;
    fallback = true;
  }

  const certaintyRaw = a ? a['confidence'] : undefined;
  const certainty = typeof certaintyRaw === 'number' && Number.isFinite(certaintyRaw) ? certaintyRaw : 0;
  // A fallback carries no calibrated probability: the model did not choose
  // this option, so borrowing a number from the distribution for it would
  // overstate the answer. Checked before the distribution on purpose.
  const probability =
    fallback ? 0
    : probabilities && typeof probabilities[value] === 'number' ? probabilities[value]!
    : certainty;

  return { kind: 'choice', value, probability, certainty, probabilities, fallback };
}

export function readScore(
  answer: unknown,
  opts: { levels?: readonly string[]; fallback?: number } = {}
): ScoreReading {
  const a = asRecord(answer);
  const levels = opts.levels;
  let value: number | null = null;
  if (a) {
    for (const key of ['score', 'expected', 'value'] as const) {
      const n = a[key];
      if (typeof n === 'number' && Number.isFinite(n)) { value = n; break; }
    }
  }
  const fallback = value === null;
  if (value === null) value = opts.fallback ?? 0;

  const maxLevel = levels && levels.length ? levels.length - 1 : Infinity;
  const level = Math.min(maxLevel === Infinity ? Math.round(value) : maxLevel, Math.max(0, Math.round(value)));
  return {
    kind: 'score',
    value,
    level,
    label: levels && levels.length ? levels[level] ?? null : null,
    probabilities: a ? numberMap(a['probabilities']) : null,
    fallback
  };
}

export function readNoul(answer: unknown, opts: { fallback?: number } = {}): NoulReading {
  const a = asRecord(answer);
  let p: number | null = null;
  if (a) {
    for (const key of ['noul', 'probability', 'yes'] as const) {
      const n = a[key];
      if (typeof n === 'number' && Number.isFinite(n)) { p = n; break; }
    }
    if (p === null) {
      const b = a['noul'] ?? a['answer'];
      if (typeof b === 'boolean') p = b ? 1 : 0;
    }
  }
  const fallback = p === null;
  if (p === null) p = opts.fallback ?? 0;
  return { kind: 'noul', probability: p, isTrue: p >= 0.5, fallback };
}

/** Read one answer using the question it came from to pick the reader. */
export function readAnswer<Q extends Question>(question: Q, answer: unknown): ReadingFor<Q> {
  if (question.type === 'choice') {
    return readChoice(answer, { allowed: optionsOf(question as ChoiceQuestion) }) as ReadingFor<Q>;
  }
  if (question.type === 'score') {
    return readScore(answer, { levels: (question as ScoreQuestion).criteria }) as ReadingFor<Q>;
  }
  return readNoul(answer) as ReadingFor<Q>;
}

/**
 * Read answers without the questions that produced them.
 *
 * Laya's answers are self-describing - each carries `type` - so a client
 * that asked by preset name can still parse them. Less precise than
 * `readAll`: there are no offered options to validate a choice against and
 * no rubric to label a score with, so pass the question shape when you have
 * one.
 */
export function readAnswersByType(
  answers: Record<string, unknown> | undefined | null
): Record<string, Reading> {
  const out: Record<string, Reading> = {};
  for (const key of Object.keys(answers ?? {})) {
    const a = asRecord((answers as Record<string, unknown>)[key]);
    const type = a ? a['type'] : undefined;
    if (type === 'choice') out[key] = readChoice(a);
    else if (type === 'score') out[key] = readScore(a);
    else if (type === 'noul') out[key] = readNoul(a);
    else if (a && typeof a['noul'] === 'number') out[key] = readNoul(a);
    else if (a && typeof a['score'] === 'number') out[key] = readScore(a);
    else out[key] = readChoice(a);
  }
  return out;
}

/**
 * Read every answer in a result, keyed the same way the questions were and
 * typed per question - so `readings.department.value` compiles without a
 * `kind` check when `department` was declared a choice.
 */
export function readAll<Q extends Questions>(
  questions: Q,
  answers: Record<string, unknown> | undefined | null
): ReadingsFor<Q> {
  const out = {} as ReadingsFor<Q>;
  for (const key of Object.keys(questions) as (keyof Q & string)[]) {
    out[key] = readAnswer(questions[key]!, answers ? answers[key] : undefined) as ReadingsFor<Q>[typeof key];
  }
  return out;
}

export interface Gate {
  accepted: boolean;
  /** Why it was refused, for logging or display. */
  reason: string | null;
}

/**
 * Confidence gating, which Laya's own documentation recommends: act on the
 * answer only when the chosen option clears a floor, and escalate otherwise.
 */
export function gate(reading: ChoiceReading | NoulReading, floor: number): Gate {
  if (reading.fallback) return { accepted: false, reason: 'no usable answer' };
  const p = reading.kind === 'choice' ? reading.probability : reading.probability;
  if (!(p >= floor)) {
    return { accepted: false, reason: `probability ${p.toFixed(3)} below floor ${floor}` };
  }
  return { accepted: true, reason: null };
}
