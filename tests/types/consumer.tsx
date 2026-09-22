/**
 * Consumer type surface.
 *
 * Compiled with `tsc --noEmit` and never executed. Every `@ts-expect-error`
 * is an assertion that the types REJECT something: if the error stops
 * happening, this file fails to compile. That is the half a runtime test
 * cannot cover.
 */
import { useState } from 'react';
import {
  LayaProvider, useDecision, useDecisionCallback, useLaya, Decision,
  ChoiceBreakdown, ScoreMeter, choice, score, noul, readAll, gate, fitToContext
} from '@laya-js/react';
import type {
  ChoiceReading, NoulReading, ScoreReading, Reading, Gate, DecideOk, Questions
} from '@laya-js/react';
import { createLayaServer } from '@laya-js/server';

function expectType<T>(_value: T): void { /* compile-time only */ }

const triage = {
  department: choice('Which team?', { billing: 'refunds', technical: 'bugs' }),
  urgency: score('How urgent?', ['low', 'medium', 'high']),
  churn: noul('Likely to cancel?')
};

const ticket = { subject: 'Duplicate charge', body: 'Billed twice.' };

/* ---------------- inline questions are inferred per question ------------- */

function Inline() {
  const { readings, gates, data, error, loading, status, ms } = useDecision({ state: ticket, questions: triage });

  if (readings) {
    // Typed by question: no `kind` narrowing needed.
    expectType<ChoiceReading>(readings.department);
    expectType<ScoreReading>(readings.urgency);
    expectType<NoulReading>(readings.churn);
    expectType<string>(readings.department.value);
    expectType<number>(readings.department.probability);
    expectType<number>(readings.urgency.value);
    expectType<string | null>(readings.urgency.label);
    expectType<boolean>(readings.churn.isTrue);

    // @ts-expect-error a score reading has no `value` of type string
    expectType<string>(readings.urgency.value);
    // @ts-expect-error a choice reading has no `isTrue`
    readings.department.isTrue;
    // @ts-expect-error a noul reading has no `label`
    readings.churn.label;
    // @ts-expect-error a question that was never asked is not a key
    readings.nonexistent;
  }

  if (gates) {
    expectType<Gate>(gates.department);
    expectType<Gate>(gates.churn);
    // @ts-expect-error score questions get no gate
    gates.urgency;
  }

  expectType<DecideOk | null>(data);
  expectType<boolean>(loading);
  expectType<number | null>(ms);
  expectType<'idle' | 'loading' | 'success' | 'error'>(status);
  if (error) expectType<string>(error.code);
  return null;
}

/* -------------------- presets: shape passed as a type ------------------- */

function WithPreset() {
  const typed = useDecision<typeof triage>({ state: ticket, preset: 'triage' });
  if (typed.readings) {
    expectType<string>(typed.readings.department.value);
    expectType<boolean>(typed.readings.churn.isTrue);
  }

  // Without a type argument the readings are the union, as they must be:
  // the questions live on the server and cannot be inferred.
  const untyped = useDecision({ state: ticket, preset: 'triage' });
  if (untyped.readings) {
    expectType<Reading>(untyped.readings.department!);
    // @ts-expect-error the union must be narrowed before reading .value
    expectType<string>(untyped.readings.department!.value);
  }
  return null;
}

/* ---------------------------- invalid inputs ---------------------------- */

function BadInputs() {
  // @ts-expect-error neither questions nor a preset
  useDecision({ state: ticket });
  // @ts-expect-error questions and preset are mutually exclusive
  useDecision({ state: ticket, questions: triage, preset: 'triage' });
  // @ts-expect-error a state is required
  useDecision({ questions: triage });
  // @ts-expect-error a choice description must be a string or null
  choice('Which?', { a: 42, b: 'ok' });
  // @ts-expect-error a score rubric is a list of strings
  score('How urgent?', [1, 2, 3]);
  // @ts-expect-error unknown option on the hook
  useDecision({ state: ticket, questions: triage }, { nope: true });
  return null;
}

/* ------------------------- imperative decisions ------------------------- */

function Imperative() {
  const [decide, state] = useDecisionCallback<typeof triage>();
  const [, setLast] = useState<string | null>(null);

  async function onSubmit() {
    const res = await decide({ state: ticket, preset: 'triage' });
    // The response is a discriminated union: `ok` narrows it.
    if (res.ok) {
      expectType<string>(res.model);
      setLast(res.model);
      // @ts-expect-error a successful response has no error code
      res.code;
    } else {
      expectType<string>(res.error);
      // @ts-expect-error a failed response has no answers
      res.answers;
    }
  }
  void onSubmit;
  if (state.readings) expectType<ChoiceReading>(state.readings.department);
  return null;
}

/* ------------------------------ components ------------------------------ */

function Components() {
  const { engine, floor, client } = useLaya();
  expectType<number>(floor);
  expectType<'laya' | 'loading' | 'unavailable' | 'unknown'>(engine);
  void client;

  const reading = readAll(triage, {}).department;
  return (
    <>
      <ChoiceBreakdown reading={reading} sorted minProbability={0.05} formatLabel={(o) => o.toUpperCase()} />
      <ScoreMeter reading={readAll(triage, {}).urgency} levels={['low', 'medium', 'high']} />
      {/* a null reading is allowed: the component renders nothing */}
      <ChoiceBreakdown reading={null} />
      {/* @ts-expect-error minProbability is a number */}
      <ChoiceBreakdown reading={reading} minProbability="high" />
      <Decision input={{ state: ticket, questions: triage }}>
        {(r) => <span>{r.readings ? r.readings.department.value : r.status}</span>}
      </Decision>
    </>
  );
}

/* --------------------------------- core --------------------------------- */

function core() {
  const g = gate(readAll(triage, {}).department, 0.34);
  expectType<boolean>(g.accepted);
  expectType<string | null>(g.reason);
  // @ts-expect-error a score reading cannot be gated
  gate(readAll(triage, {}).urgency, 0.34);

  const fitted = fitToContext(ticket, triage, { budget: 400, dropStateKeys: ['body'], shortenQuestion: 'department' });
  expectType<string[]>(fitted.trimmed);
  expectType<boolean>(fitted.overBudget);
  expectType<Questions>(fitted.questions);
}

/* -------------------------------- server -------------------------------- */

const server = createLayaServer({
  presets: { triage, dynamic: (state) => ({ pick: choice('Which?', { a: 'x', b: 'y' }) }) },
  allowAdHoc: false,
  context: 'multilingual',
  fit: { dropStateKeys: ['body'] },
  load: async () => ({ systemOne: async () => ({ model: 'stub', answers: {} }) })
});
expectType<string[]>(server.health().presets);
// @ts-expect-error context is one of the two known checkpoints
createLayaServer({ context: 'klingon' });
// @ts-expect-error a preset must be questions or a function returning them
createLayaServer({ presets: { bad: 'nope' } });

async function serverUse() {
  const r = await server.decide({ state: ticket, preset: 'triage' });
  if (r.ok) expectType<number>(r.ms);
  const res = await server.fetchHandler(new Request('http://x/laya/decide'));
  expectType<Response>(res);
}

export { Inline, WithPreset, BadInputs, Imperative, Components, core, serverUse, LayaProvider };
