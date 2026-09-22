import { ok, eq, section, summary } from '../../../../tools/harness.mjs';
import { setupDom, flush } from './dom.mjs';

setupDom();

const React = (await import('react')).default;
const { createElement: h, StrictMode, useState } = React;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const L = await import('../dist/index.js');

const questions = {
  department: L.choice('Which team?', { billing: 'refunds', support: 'bugs' }),
  urgency: L.score('How urgent?', ['low', 'medium', 'high', 'critical'])
};
const state = { subject: 'Duplicate charge' };

/** A fake client: same surface as core's, fully controllable. */
function fakeClient(opts = {}) {
  const calls = [];
  let resolveNext = null;
  const client = {
    endpoint: 'http://test', engine: 'unknown', reason: null, inFlight: 0, calls,
    async health(o = {}) {
      calls.push({ kind: 'health', signal: o.signal });
      if (opts.healthFails) { client.engine = 'unavailable'; client.reason = 'down'; return null; }
      const body = { engine: 'laya', model: 'laya-english', contextTokens: 512, reason: null, presets: ['triage'], allowAdHoc: false, calls: 0, avgMs: 0 };
      client.engine = 'laya';
      return body;
    },
    async decide(request, o = {}) {
      const record = { kind: 'decide', request, signal: o.signal, timeoutMs: o.timeoutMs };
      calls.push(record);
      if (opts.manual) {
        return new Promise((res) => {
          resolveNext = (value) => res(value);
          record.resolve = (value) => res(value);
          if (o.signal) {
            o.signal.addEventListener('abort', () => {
              record.aborted = true;
              res({ ok: false, engine: 'unavailable', code: 'aborted', error: 'cancelled by the caller', ms: 0 });
            }, { once: true });
          }
        });
      }
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
      if (opts.error) return { ok: false, engine: 'unavailable', code: opts.error, error: 'nope: ' + opts.error, ms: 3 };
      return {
        ok: true, engine: 'laya', model: 'laya-english', ms: 33, tokens: 210,
        answers: {
          department: { type: 'choice', choice: opts.choice ?? 'billing', probabilities: opts.probs ?? { billing: 0.94, support: 0.06 }, confidence: 0.6 },
          urgency: { type: 'score', score: 2.4, legend: {}, probabilities: {}, confidence: 0.4 }
        }
      };
    }
  };
  client.resolveNext = (v) => resolveNext?.(v);
  return client;
}

function mount(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root, unmount: () => act(() => root.unmount()) };
}

section('the provider');
{
  const client = fakeClient();
  let seen = null;
  function Probe() {
    seen = L.useLaya();
    return h('div', null, 'ok');
  }
  const m = mount(h(L.LayaProvider, { client }, h(Probe)));
  await flush(act);
  ok('the client is provided', seen.client === client);
  ok('the default floor is Laya\'s recommended gate', seen.floor === 0.34, String(seen.floor));
  ok('health is fetched on mount', client.calls.some((c) => c.kind === 'health'));
  ok('engine state is exposed', seen.engine === 'laya', seen.engine);
  ok('the health body is exposed', seen.health?.contextTokens === 512);
  m.unmount();

  const custom = mount(h(L.LayaProvider, { client: fakeClient(), floor: 0.8, checkHealth: false }, h(Probe)));
  await flush(act);
  ok('the floor is configurable', seen.floor === 0.8);
  ok('health checks can be turned off', !seen.client.calls.some((c) => c.kind === 'health'));
  custom.unmount();

  const down = fakeClient({ healthFails: true });
  const m3 = mount(h(L.LayaProvider, { client: down }, h(Probe)));
  await flush(act);
  ok('an unreachable endpoint is reported, not thrown', seen.engine === 'unavailable', seen.engine);
  m3.unmount();
}

section('using a hook outside the provider');
{
  let caught = null;
  function Bare() {
    try { L.useLaya(); } catch (e) { caught = e; }
    return null;
  }
  const m = mount(h(Bare));
  ok('useLaya explains the missing provider', caught && /<LayaProvider>/.test(caught.message), caught?.message);
  m.unmount();

  let optional = 'unset';
  function Optional() { optional = L.useOptionalLaya(); return null; }
  const m2 = mount(h(Optional));
  ok('useOptionalLaya returns null instead of throwing', optional === null);
  m2.unmount();
}

section('useDecision');
{
  const client = fakeClient();
  let last = null;
  function Ask() {
    last = L.useDecision({ state, questions });
    return h('div', null, last.status);
  }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  ok('it starts loading immediately', last.status === 'loading' && last.loading === true, last.status);
  await flush(act);
  ok('it resolves to success', last.status === 'success' && last.loading === false, last.status);
  ok('the raw response is exposed', last.data?.ok === true && last.data.model === 'laya-english');
  ok('answers are exposed', last.answers?.department.choice === 'billing');
  ok('readings are parsed', last.readings?.department.kind === 'choice' && last.readings.department.value === 'billing');
  ok('the score reading is labelled from the rubric', last.readings?.urgency.label === 'high', String(last.readings?.urgency.label));
  ok('the choice probability is the chosen option', Math.abs(last.readings.department.probability - 0.94) < 1e-9);
  ok('server timing is exposed', last.ms === 33);
  ok('gates are computed for choices', last.gates?.department.accepted === true);
  ok('score questions are not gated', last.gates?.urgency === undefined);
  ok('exactly one request was made', client.calls.filter((c) => c.kind === 'decide').length === 1);
  eq('the request carries state and questions',
     Object.keys(client.calls.find((c) => c.kind === 'decide').request).sort(), ['questions', 'state']);
  ok('the dom rendered the status', m.container.textContent === 'success', m.container.textContent);
  m.unmount();
}

section('gating a low-confidence answer');
{
  const client = fakeClient({ choice: 'billing', probs: { billing: 0.31, support: 0.29, sales: 0.4 } });
  let last = null;
  function Ask() { last = L.useDecision({ state, questions }); return null; }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  await flush(act);
  ok('an unsure choice is not accepted', last.gates.department.accepted === false);
  ok('the gate explains itself', /below floor/.test(last.gates.department.reason), last.gates.department.reason);
  ok('the answer is still available to the caller', last.readings.department.value === 'billing');
  m.unmount();

  const m2 = mount(h(L.LayaProvider, { client: fakeClient({ probs: { billing: 0.31, support: 0.69 } }), checkHealth: false },
                     h(function A() { last = L.useDecision({ state, questions }, { floor: 0.2 }); return null; })));
  await flush(act);
  ok('the floor can be overridden per decision', last.gates.department.accepted === true);
  m2.unmount();
}

section('re-asking only when the input really changes');
{
  const client = fakeClient();
  let setSubject = null;
  let renders = 0;
  function Ask() {
    const [subject, set] = useState('a');
    setSubject = set;
    renders++;
    L.useDecision({ state: { subject }, questions });
    return null;
  }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  await flush(act);
  const after = () => client.calls.filter((c) => c.kind === 'decide').length;
  ok('one request for the first render', after() === 1, String(after()));

  await act(async () => { setSubject('a'); });
  await flush(act);
  ok('an identical input does not re-ask', after() === 1, String(after()));

  await act(async () => { setSubject('b'); });
  await flush(act);
  ok('a changed input re-asks', after() === 2, String(after()));
  ok('the new request carries the new state',
     client.calls.filter((c) => c.kind === 'decide')[1].request.state.subject === 'b');
  m.unmount();
}

section('enabled, refresh and cancel');
{
  const client = fakeClient();
  let last = null;
  let setOn = null;
  function Ask() {
    const [on, set] = useState(false);
    setOn = set;
    last = L.useDecision({ state, questions }, { enabled: on });
    return null;
  }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  await flush(act);
  ok('disabled means idle and no request', last.status === 'idle' && client.calls.filter((c) => c.kind === 'decide').length === 0);
  await act(async () => { setOn(true); });
  await flush(act);
  ok('enabling asks', last.status === 'success' && client.calls.filter((c) => c.kind === 'decide').length === 1);

  await act(async () => { last.refresh(); });
  await flush(act);
  ok('refresh re-asks the same input', client.calls.filter((c) => c.kind === 'decide').length === 2);
  m.unmount();

  const manual = fakeClient({ manual: true });
  function Ask2() { last = L.useDecision({ state, questions }); return null; }
  const m2 = mount(h(L.LayaProvider, { client: manual, checkHealth: false }, h(Ask2)));
  ok('a pending decision reports loading', last.loading === true);
  await act(async () => { last.cancel(); });
  ok('cancel stops loading', last.loading === false && last.status === 'idle', last.status);
  ok('cancel aborted the request', manual.calls.find((c) => c.kind === 'decide').aborted === true);
  m2.unmount();
}

section('a superseded answer never overwrites a newer one');
{
  const client = fakeClient({ manual: true });
  let last = null;
  let setSubject = null;
  function Ask() {
    const [subject, set] = useState('first');
    setSubject = set;
    last = L.useDecision({ state: { subject }, questions });
    return null;
  }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  const first = client.calls.find((c) => c.kind === 'decide');
  await act(async () => { setSubject('second'); });
  const decides = client.calls.filter((c) => c.kind === 'decide');
  ok('the second request started', decides.length === 2, String(decides.length));
  ok('the first was aborted when superseded', first.aborted === true);

  // Answer the stale request late, with a distinguishable payload.
  await act(async () => {
    first.resolve({
      ok: true, engine: 'laya', model: 'STALE', ms: 999,
      answers: { department: { type: 'choice', choice: 'support', probabilities: { support: 1 }, confidence: 1 },
                 urgency: { type: 'score', score: 0 } }
    });
  });
  await flush(act);
  ok('the stale answer is ignored', last.data?.model !== 'STALE', String(last.data?.model));
  ok('the hook is still waiting for the live request', last.loading === true, last.status);

  await act(async () => {
    decides[1].resolve({
      ok: true, engine: 'laya', model: 'FRESH', ms: 10,
      answers: { department: { type: 'choice', choice: 'billing', probabilities: { billing: 1 }, confidence: 1 },
                 urgency: { type: 'score', score: 3 } }
    });
  });
  await flush(act);
  ok('the live answer lands', last.data?.model === 'FRESH' && last.status === 'success', String(last.data?.model));
  m.unmount();
}

section('errors');
{
  for (const [code, label] of [['unavailable', 'a missing model'], ['forbidden', 'a preset-only endpoint'], ['too_large', 'an oversized prompt'], ['unreachable', 'a dead endpoint']]) {
    const client = fakeClient({ error: code });
    let last = null;
    function Ask() { last = L.useDecision({ state, questions }); return null; }
    const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
    await flush(act);
    ok(label + ' surfaces as an error state', last.status === 'error' && last.error.code === code, last.status + '/' + last.error?.code);
    ok(label + ' keeps the message', /nope/.test(last.error.error));
    ok(label + ' leaves no stale readings', last.readings === null && last.answers === null);
    m.unmount();
  }

  let errored = null;
  const client = fakeClient({ error: 'unavailable' });
  function Ask() { L.useDecision({ state, questions }, { onError: (e) => { errored = e; } }); return null; }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  await flush(act);
  ok('onError is called', errored?.code === 'unavailable');
  m.unmount();

  let succeeded = null;
  const m2 = mount(h(L.LayaProvider, { client: fakeClient(), checkHealth: false },
    h(function A() { L.useDecision({ state, questions }, { onSuccess: (d) => { succeeded = d; } }); return null; })));
  await flush(act);
  ok('onSuccess is called', succeeded?.ok === true);
  m2.unmount();
}

section('unmounting mid-flight');
{
  const client = fakeClient({ manual: true });
  function Ask() { L.useDecision({ state, questions }); return null; }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  const call = client.calls.find((c) => c.kind === 'decide');
  const warnings = [];
  const realError = console.error;
  console.error = (...args) => warnings.push(args.join(' '));
  m.unmount();
  await act(async () => { call.resolve({ ok: true, engine: 'laya', model: 'late', ms: 1, answers: {} }); });
  await flush(act);
  console.error = realError;
  ok('the request is aborted on unmount', call.aborted === true);
  ok('a late answer after unmount logs no react warning', warnings.length === 0, warnings.join(' | '));
}

section('strict mode');
{
  const client = fakeClient();
  let last = null;
  function Ask() { last = L.useDecision({ state, questions }); return null; }
  const m = mount(h(StrictMode, null, h(L.LayaProvider, { client, checkHealth: false }, h(Ask))));
  await flush(act);
  ok('it still resolves under double-invoked effects', last.status === 'success', last.status);
  ok('the answer is intact', last.readings?.department.value === 'billing');
  m.unmount();
}

section('useDecisionCallback');
{
  const client = fakeClient();
  let decide = null, cbState = null;
  function Imperative() {
    [decide, cbState] = L.useDecisionCallback();
    return null;
  }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Imperative)));
  await flush(act);
  ok('nothing is asked until called', client.calls.filter((c) => c.kind === 'decide').length === 0);
  ok('it starts idle', cbState.loading === false && cbState.data === null);

  let returned = null;
  await act(async () => { returned = await decide({ state, questions }); });
  await flush(act);
  ok('it returns the response to the caller', returned?.ok === true && returned.model === 'laya-english');
  ok('state is updated too', cbState.data?.ok === true && cbState.loading === false);
  ok('readings are parsed', cbState.readings?.department.value === 'billing');

  await act(async () => { cbState.reset(); });
  ok('reset clears it', cbState.data === null && cbState.readings === null);

  const failing = fakeClient({ error: 'unavailable' });
  let r2 = null;
  const m2 = mount(h(L.LayaProvider, { client: failing, checkHealth: false },
    h(function I() { [decide, cbState] = L.useDecisionCallback(); return null; })));
  await act(async () => { r2 = await decide({ state, preset: 'triage' }); });
  await flush(act);
  ok('failures come back as values, not throws', r2?.ok === false && r2.code === 'unavailable');
  ok('and land in state', cbState.error?.code === 'unavailable');
  m.unmount(); m2.unmount();
}

section('presets');
{
  const client = fakeClient();
  let last = null;
  function Ask() { last = L.useDecision({ state, preset: 'triage' }); return null; }
  const m = mount(h(L.LayaProvider, { client, checkHealth: false }, h(Ask)));
  await flush(act);
  const req = client.calls.find((c) => c.kind === 'decide').request;
  eq('a preset request sends the name only', Object.keys(req).sort(), ['preset', 'state']);
  // The client has no questions, but Laya's answers are self-describing.
  ok('readings are still parsed without questions', last.readings?.department.kind === 'choice',
     JSON.stringify(last.readings));
  ok('the choice is read', last.readings.department.value === 'billing');
  ok('the score is read', last.readings.urgency.kind === 'score');
  ok('a score has no rubric label without the shape', last.readings.urgency.label === null);
  ok('gates are still computed', last.gates?.department.accepted === true);
  m.unmount();

  const shaped = fakeClient();
  function AskShaped() {
    last = L.useDecision({ state, preset: 'triage' }, { shape: questions });
    return null;
  }
  const m2 = mount(h(L.LayaProvider, { client: shaped, checkHealth: false }, h(AskShaped)));
  await flush(act);
  const req2 = shaped.calls.find((c) => c.kind === 'decide').request;
  eq('the shape is never sent to the server', Object.keys(req2).sort(), ['preset', 'state']);
  ok('with a shape the score is labelled from the rubric', last.readings.urgency.label === 'high',
     String(last.readings.urgency.label));
  ok('with a shape a choice is validated against the offered options',
     last.readings.department.fallback === false);
  m2.unmount();

  // An option the server never offered must fall back once a shape is known.
  const lying = fakeClient({ choice: 'legal', probs: { legal: 0.9, billing: 0.1 } });
  function AskLying() { last = L.useDecision({ state, preset: 'triage' }, { shape: questions }); return null; }
  const m3 = mount(h(L.LayaProvider, { client: lying, checkHealth: false }, h(AskLying)));
  await flush(act);
  ok('an option outside the shape is rejected', last.readings.department.fallback === true,
     last.readings.department.value);
  ok('and it is never gated through', last.gates.department.accepted === false);
  m3.unmount();
}

section('components');
{
  const client = fakeClient();
  let captured = null;
  const m = mount(h(L.LayaProvider, { client, checkHealth: false },
    h(L.Decision, { input: { state, questions } }, (r) => {
      captured = r;
      return r.loading ? h('p', null, 'thinking') : h('p', null, r.readings?.department.value ?? 'none');
    })));
  ok('the render prop sees the loading state', m.container.textContent === 'thinking', m.container.textContent);
  await flush(act);
  ok('the render prop sees the answer', m.container.textContent === 'billing', m.container.textContent);
  ok('it passes the full result through', captured.status === 'success');
  m.unmount();

  const reading = L.readChoice(
    { type: 'choice', choice: 'support', probabilities: { billing: 0.25, support: 0.7, sales: 0.05 }, confidence: 0.5 },
    { allowed: ['billing', 'support', 'sales'] }
  );
  const html = renderToStaticMarkup(h(L.ChoiceBreakdown, { reading }));
  ok('the breakdown renders one row per option', (html.match(/laya-breakdown-row/g) || []).length === 3, html.slice(0, 80));
  ok('it marks the chosen option', /data-chosen="true"/.test(html));
  ok('it shows probabilities', /0\.70/.test(html) && /0\.25/.test(html));
  ok('it sorts by probability by default', html.indexOf('support') < html.indexOf('billing'));
  const filtered = renderToStaticMarkup(h(L.ChoiceBreakdown, { reading, minProbability: 0.1 }));
  ok('minProbability hides long-tail options', (filtered.match(/laya-breakdown-row/g) || []).length === 2);
  ok('a non-choice reading renders nothing',
     renderToStaticMarkup(h(L.ChoiceBreakdown, { reading: L.readScore({ score: 1 }) })) === '');
  ok('a null reading renders nothing', renderToStaticMarkup(h(L.ChoiceBreakdown, { reading: null })) === '');
  ok('labels can be formatted',
     /Billing/.test(renderToStaticMarkup(h(L.ChoiceBreakdown, { reading, formatLabel: (o) => o[0].toUpperCase() + o.slice(1) }))));

  const scoreHtml = renderToStaticMarkup(h(L.ScoreMeter, {
    reading: L.readScore({ score: 2.4 }, { levels: ['low', 'medium', 'high', 'critical'] }),
    levels: ['low', 'medium', 'high', 'critical']
  }));
  ok('the meter is accessible', /role="meter"/.test(scoreHtml) && /aria-valuenow="2.4"/.test(scoreHtml), scoreHtml.slice(0, 100));
  ok('the meter labels the level', /high/.test(scoreHtml));
  ok('the meter lights the right number of steps', (scoreHtml.match(/data-on="true"/g) || []).length === 3);
}

section('server-side rendering');
{
  // No window, no fetch during render: the first pass must be safe.
  const client = fakeClient();
  const html = renderToStaticMarkup(
    h(L.LayaProvider, { client, checkHealth: true },
      h(L.Decision, { input: { state, questions } }, (r) => h('p', null, r.status)))
  );
  ok('it renders on the server without throwing', html === '<p>idle</p>' || html === '<p>loading</p>', html);
  ok('no request is made during render', client.calls.filter((c) => c.kind === 'decide').length === 0,
     String(client.calls.length));
}

summary();
