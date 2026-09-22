import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import type { ChoiceReading, Questions, Reading, ScoreReading } from '@laya-js/core';
import { useDecision } from './useDecision.js';
import type { DecisionInput, DecisionResult, UseDecisionOptions } from './useDecision.js';

/**
 * Render-prop form, for when a component tree wants a decision without a
 * custom hook. Unstyled on purpose: class names are the styling surface.
 */
export interface DecisionProps<Q extends Questions = Questions> extends UseDecisionOptions {
  input: DecisionInput<Q>;
  children: (result: DecisionResult<Q>) => ReactNode;
}

export function Decision<Q extends Questions = Questions>({ input, children, ...options }: DecisionProps<Q>) {
  // The overloads on useDecision are resolved by the caller's input type;
  // inside the generic component both branches are possible at once.
  const result = useDecision(input as { state: never; preset: string }, options) as DecisionResult<Q>;
  return createElement(Fragment, null, children(result));
}

export interface ChoiceBreakdownProps {
  reading: Reading | null | undefined;
  /** Order rows by probability instead of the order the options were given. */
  sorted?: boolean;
  /** Hide options below this probability. */
  minProbability?: number;
  className?: string;
  formatLabel?: (option: string) => string;
}

/**
 * The distribution behind a choice, not just the winner. Laya's
 * probabilities are calibrated, so showing them is usually more honest
 * than showing the single option it picked.
 */
export function ChoiceBreakdown(props: ChoiceBreakdownProps) {
  const { reading, sorted = true, minProbability = 0, className, formatLabel } = props;
  if (!reading || reading.kind !== 'choice') return null;
  const r = reading as ChoiceReading;
  const probs = r.probabilities ?? {};
  let rows = Object.keys(probs).map((option) => ({ option, p: probs[option] ?? 0 }));
  if (!rows.length) rows = [{ option: r.value, p: r.probability }];
  if (minProbability > 0) rows = rows.filter((row) => row.p >= minProbability);
  if (sorted) rows.sort((a, b) => b.p - a.p);

  return createElement(
    'ul',
    { className: className ?? 'laya-breakdown', 'data-fallback': r.fallback || undefined },
    rows.map((row) =>
      createElement(
        'li',
        {
          key: row.option,
          className: 'laya-breakdown-row',
          'data-chosen': row.option === r.value || undefined
        },
        createElement('span', { className: 'laya-breakdown-label' }, formatLabel ? formatLabel(row.option) : row.option),
        createElement('span', {
          className: 'laya-breakdown-bar',
          style: { ['--laya-p' as string]: String(row.p) },
          'aria-hidden': true
        }),
        createElement('span', { className: 'laya-breakdown-value' }, row.p.toFixed(2))
      )
    )
  );
}

export interface ScoreMeterProps {
  reading: Reading | null | undefined;
  levels?: readonly string[];
  className?: string;
}

/** An ordinal score as a labelled meter over its rubric. */
export function ScoreMeter({ reading, levels, className }: ScoreMeterProps) {
  if (!reading || reading.kind !== 'score') return null;
  const r = reading as ScoreReading;
  const count = levels?.length ?? 4;
  return createElement(
    'div',
    {
      className: className ?? 'laya-score',
      role: 'meter',
      'aria-valuenow': r.value,
      'aria-valuemin': 0,
      'aria-valuemax': count - 1,
      'aria-valuetext': r.label ?? String(r.level),
      'data-level': r.level
    },
    Array.from({ length: count }, (_unused, i) =>
      createElement('span', {
        key: i,
        className: 'laya-score-step',
        'data-on': i <= r.level || undefined
      })
    ),
    createElement('span', { className: 'laya-score-label' }, r.label ?? String(r.level))
  );
}
