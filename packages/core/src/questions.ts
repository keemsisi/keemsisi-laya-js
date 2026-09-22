import type { ChoiceQuestion, NoulQuestion, ScoreQuestion } from './types.js';

/**
 * Typed builders. They exist so a malformed question is a compile error
 * rather than a confusing answer: `score` takes an ordered rubric, `choice`
 * takes options, and `noul` takes neither.
 */

export function choice<K extends string>(
  instructions: string | object,
  criteria: Record<K, string | null> | readonly K[]
): ChoiceQuestion {
  return {
    type: 'choice',
    instructions,
    criteria: Array.isArray(criteria) ? ([...criteria] as string[]) : ({ ...criteria } as Record<string, string | null>)
  };
}

export function score(instructions: string | object, levels: readonly string[]): ScoreQuestion {
  if (levels.length < 2) throw new TypeError('a score question needs at least two levels');
  return { type: 'score', instructions, criteria: [...levels] };
}

export function noul(
  instructions: string | object,
  criteria?: { true?: string; false?: string }
): NoulQuestion {
  return criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions };
}

/** The option keys of a choice question, whichever form `criteria` took. */
export function optionsOf(q: ChoiceQuestion): string[] {
  return Array.isArray(q.criteria) ? [...q.criteria] : Object.keys(q.criteria);
}

/**
 * Validate questions arriving from an untrusted caller.
 *
 * A Laya endpoint takes free-form text and an arbitrary question map, so the
 * shape has to be checked before it reaches the model: a malformed question
 * otherwise becomes a confusing answer or a crash inside inference.
 * Returns a list of problems; empty means valid.
 */
export interface ValidateLimits {
  maxQuestions?: number;
  maxOptions?: number;
  maxTextChars?: number;
}

export function validateQuestions(value: unknown, limits: ValidateLimits = {}): string[] {
  const maxQuestions = limits.maxQuestions ?? 16;
  const maxOptions = limits.maxOptions ?? 32;
  const maxText = limits.maxTextChars ?? 8_000;
  const problems: string[] = [];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['questions must be an object keyed by question name'];
  }
  const keys = Object.keys(value as object);
  if (keys.length === 0) problems.push('at least one question is required');
  if (keys.length > maxQuestions) problems.push(`too many questions (${keys.length} > ${maxQuestions})`);

  for (const key of keys) {
    const q = (value as Record<string, unknown>)[key] as Record<string, unknown> | null;
    const at = `questions.${key}`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) { problems.push(`${at} must be an object`); continue; }

    const type = q['type'];
    if (type !== 'choice' && type !== 'score' && type !== 'noul') {
      problems.push(`${at}.type must be "choice", "score" or "noul"`);
      continue;
    }
    const instructions = q['instructions'];
    if (typeof instructions === 'string') {
      if (instructions.length === 0) problems.push(`${at}.instructions must not be empty`);
      if (instructions.length > maxText) problems.push(`${at}.instructions is too long`);
    } else if (!instructions || typeof instructions !== 'object') {
      problems.push(`${at}.instructions must be a string or an object`);
    }

    const criteria = q['criteria'];
    if (type === 'choice') {
      if (Array.isArray(criteria)) {
        if (criteria.length < 2) problems.push(`${at}.criteria needs at least two options`);
        else if (criteria.length > maxOptions) problems.push(`${at}.criteria has too many options`);
        if (!criteria.every((c) => typeof c === 'string' && c.length > 0)) {
          problems.push(`${at}.criteria options must be non-empty strings`);
        }
      } else if (criteria && typeof criteria === 'object') {
        const opts = Object.keys(criteria as object);
        if (opts.length < 2) problems.push(`${at}.criteria needs at least two options`);
        else if (opts.length > maxOptions) problems.push(`${at}.criteria has too many options`);
        for (const o of opts) {
          const d = (criteria as Record<string, unknown>)[o];
          if (d !== null && typeof d !== 'string') problems.push(`${at}.criteria.${o} must be a string or null`);
          else if (typeof d === 'string' && d.length > maxText) problems.push(`${at}.criteria.${o} is too long`);
        }
      } else {
        problems.push(`${at}.criteria must be an object or an array of options`);
      }
    } else if (type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        problems.push(`${at}.criteria must be an ordered array of at least two levels`);
      } else if (criteria.length > maxOptions) {
        problems.push(`${at}.criteria has too many levels`);
      } else if (!criteria.every((c) => typeof c === 'string' && c.length > 0)) {
        problems.push(`${at}.criteria levels must be non-empty strings`);
      }
    } else if (criteria !== undefined) {
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
        problems.push(`${at}.criteria must be an object with true/false descriptions`);
      }
    }
  }
  return problems;
}

/** Validate a state payload from an untrusted caller. */
export function validateState(value: unknown, maxChars = 100_000): string[] {
  if (typeof value === 'string') {
    return value.length > maxChars ? ['state is too long'] : [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['state must be an object or a string'];
  }
  let total = 0;
  for (const k of Object.keys(value as object)) {
    const v = (value as Record<string, unknown>)[k];
    total += k.length + (typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length);
  }
  return total > maxChars ? ['state is too long'] : [];
}
