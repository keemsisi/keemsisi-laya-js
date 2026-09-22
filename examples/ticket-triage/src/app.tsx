import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  LayaProvider, useLaya, useDecision, ChoiceBreakdown, ScoreMeter
} from '@laya-js/react';
import { triage, URGENCY_LEVELS } from './presets.mjs';

/** Laya answers in one forward pass, but not for free - don't ask per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

const SAMPLES = [
  { subject: 'Duplicate charge on invoice #4411', body: 'We were billed twice for March and need one of them refunded.' },
  { subject: 'API returning 500 since this morning', body: 'Every call to /v2/orders fails. This is blocking our checkout.' },
  { subject: 'Question about enterprise pricing', body: 'We are 40 seats and want to compare the annual plans.' },
  { subject: 'Cancelling our account', body: 'This is the third outage this month. We are moving to a competitor unless this is fixed today.' }
];

function EngineBadge() {
  const { engine, reason, health, refreshHealth } = useLaya();
  const label = engine === 'laya' ? 'engine ready' : engine === 'loading' ? 'loading' : engine === 'unavailable' ? 'unavailable' : 'checking';
  // `engine` only says a model is loaded. The model's own name is the honest
  // identity - a stub must not read as the real checkpoint.
  // `model` is the id the model reported on its last answer; `modelSource`
  // is what the server was configured with and is known before any answer.
  const name = health?.model ?? health?.modelSource ?? null;
  const isStub = name ? /stub|injected/i.test(name) || !/laya/i.test(name) : false;
  return (
    <div className="badge-row">
      <span className={'badge badge-' + engine} onClick={refreshHealth} title="click to re-check">{label}</span>
      {name ? (
        <span className={'badge ' + (isStub ? 'badge-unavailable' : 'badge-laya')} title="model">{name}</span>
      ) : null}
      {health?.presets?.length ? <span className="muted">presets: {health.presets.join(', ')}</span> : null}
      {reason ? <span className="muted reason">{reason}</span> : null}
    </div>
  );
}

function Triage() {
  const [ticket, setTicket] = useState(SAMPLES[0]!);
  const settled = useDebounced(ticket, 400);
  const enabled = settled.subject.trim().length > 3;

  // One decision per settled ticket. Re-asks when the text changes, aborts
  // the previous request, and ignores any answer that arrives out of order.
  const { status, loading, readings, gates, error, data, ms, refresh } =
    useDecision({ state: settled, preset: 'triage' }, { enabled, shape: triage });

  return (
    <main>
      <header>
        <h1>Ticket triage</h1>
        <EngineBadge />
      </header>

      <section className="card">
        <label>
          Subject
          <input value={ticket.subject} onChange={(e) => setTicket({ ...ticket, subject: e.target.value })} />
        </label>
        <label>
          Body
          <textarea rows={4} value={ticket.body} onChange={(e) => setTicket({ ...ticket, body: e.target.value })} />
        </label>
        <div className="samples">
          {SAMPLES.map((s, i) => (
            <button key={i} className="ghost" onClick={() => setTicket(s)}>{s.subject.slice(0, 28)}…</button>
          ))}
          <button className="ghost" onClick={refresh} disabled={!enabled}>Ask again</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Decision</h2>
          <span className="muted">
            {!enabled ? 'waiting for a subject'
              : loading ? 'deciding…'
              : status === 'success' ? `${data?.model} · ${ms}ms · ~${data?.tokens} tokens`
              : status === 'error' ? 'failed'
              : 'idle'}
          </span>
        </div>

        {error ? (
          <div className="error">
            <strong>{error.code}</strong>
            <p>{error.error}</p>
            {error.code === 'unavailable' ? (
              <p className="muted">
                Start the server with a model: <code>npm install @receptron/laya</code> then{' '}
                <code>LAYA=1 node server.mjs</code>. Or run <code>node server.mjs --fake</code> for a stub.
              </p>
            ) : null}
          </div>
        ) : null}

        {readings ? (
          <div className="answers">
            <div>
              <h3>Route to</h3>
              <p className="answer">
                {readings.department.value}
                {gates && !gates.department.accepted ? (
                  <span className="gate" title={gates.department.reason ?? ''}>needs a human</span>
                ) : null}
              </p>
              <ChoiceBreakdown reading={readings.department} />
            </div>
            <div>
              <h3>Urgency</h3>
              <ScoreMeter reading={readings.urgency} levels={URGENCY_LEVELS} />
            </div>
            <div>
              <h3>Churn risk</h3>
              <p className="answer">
                {(readings.churn.isTrue ? 'likely' : 'unlikely') + ' · p=' + readings.churn.probability.toFixed(2)}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <footer className="muted">
        Laya returns calibrated probabilities, so the distribution is shown rather than just the winner.
        A choice below the confidence floor is marked for a human instead of routed automatically.
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <LayaProvider endpoint="" floor={0.34} healthIntervalMs={5000}>
    <Triage />
  </LayaProvider>
);
