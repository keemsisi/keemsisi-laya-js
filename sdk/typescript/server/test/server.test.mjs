import { ok, eq, section, summary } from '../../../../scripts/harness.mjs';
import { createLayaServer } from '../dist/index.js';
import { choice, score, noul, optionsOf } from '@laya-js/core';
import http from 'node:http';

/** A stand-in for the real checkpoint: same contract, no 1.7 GB. */
function fakeModel(opts = {}) {
  const stats = { calls: [], concurrent: 0, maxConcurrent: 0, closed: false };
  const model = {
    stats,
    config: { max_len: 512 },
    async systemOne(state, questions) {
      stats.concurrent++;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.concurrent);
      stats.calls.push({ state, questions });
      try {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
        if (opts.fail) throw new Error(opts.fail);
        if (opts.garbage) return { model: 'fake' };
        const answers = {};
        for (const [key, q] of Object.entries(questions)) {
          if (q.type === 'choice') {
            const options = optionsOf(q);
            const probs = {};
            options.forEach((o, i) => { probs[o] = i === 0 ? 0.8 : 0.2 / (options.length - 1); });
            answers[key] = { type: 'choice', choice: options[0], probabilities: probs, confidence: 0.55, rl_agent: { act_probability: 1 } };
          } else if (q.type === 'score') {
            answers[key] = { type: 'score', score: 1.5, legend: {}, probabilities: {}, confidence: 0.5, rl_agent: { act_probability: 1 } };
          } else {
            answers[key] = { type: 'noul', noul: 0.42, rl_agent: { act_probability: 1 } };
          }
        }
        return { model: 'laya-english', answers, usage: { input_tokens: 210, output_tokens: 0 } };
      } finally { stats.concurrent--; }
    },
    async close() { stats.closed = true; }
  };
  return model;
}

const triage = {
  department: choice('Which team?', { billing: 'refunds', support: 'bugs', sales: 'purchases' }),
  urgency: score('How urgent?', ['low', 'medium', 'high', 'critical']),
  churn: noul('Likely to cancel?')
};
const state = { subject: 'Refund not received', body: 'I cancelled two weeks ago.' };

section('health before anything is loaded');
{
  const s = createLayaServer({ presets: { triage }, load: async () => fakeModel() });
  const h = s.health();
  ok('the engine starts unavailable, not pretending', h.engine === 'unavailable');
  ok('no model is claimed before one has answered', h.model === null && h.contextTokens === null);
  eq('presets are advertised', h.presets, ['triage']);
  ok('ad-hoc is off by default', h.allowAdHoc === false);
  ok('no calls yet', h.calls === 0 && h.avgMs === 0);
}

section('a preset decision');
{
  const model = fakeModel();
  const s = createLayaServer({ presets: { triage }, load: async () => model });
  const r = await s.decide({ state, preset: 'triage' });
  ok('it succeeds', r.ok === true, JSON.stringify(r).slice(0, 120));
  ok('the engine is laya', r.engine === 'laya');
  ok('the model name is passed through', r.model === 'laya-english');
  eq('every question is answered', Object.keys(r.answers).sort(), ['churn', 'department', 'urgency']);
  ok('usage is passed through', r.usage.input_tokens === 210);
  ok('timing is reported', typeof r.ms === 'number' && r.ms >= 0);
  ok('the token estimate is reported', r.tokens > 0);
  ok('nothing was trimmed', r.trimmed === undefined);
  ok('the model got the state', model.stats.calls[0].state === state);
  ok('the model got the preset questions', Object.keys(model.stats.calls[0].questions).length === 3);

  const h = s.health();
  ok('health now reports the engine as loaded', h.engine === 'laya');
  ok('health names the model the answer actually came from, not a guess',
     h.model === 'laya-english', String(h.model));
  ok('the context window comes from the checkpoint', h.contextTokens === 512, String(h.contextTokens));
  ok('the call is counted', h.calls === 1 && h.avgMs >= 0);
}

section('ad-hoc questions are refused by default');
{
  const s = createLayaServer({ presets: { triage }, load: async () => fakeModel() });
  const r = await s.decide({ state, questions: triage });
  ok('refused', r.ok === false && r.code === 'forbidden', r.code);
  ok('the message says how to fix it', /allowAdHoc: true/.test(r.error) && /triage/.test(r.error), r.error);

  const open = createLayaServer({ allowAdHoc: true, load: async () => fakeModel() });
  const r2 = await open.decide({ state, questions: { pick: choice('Which?', { a: 'x', b: 'y' }) } });
  ok('allowed when opted in', r2.ok === true && r2.answers.pick.choice === 'a');
  ok('health advertises that it is open', open.health().allowAdHoc === true);
}

section('bad requests');
{
  const s = createLayaServer({ allowAdHoc: true, presets: { triage }, load: async () => fakeModel() });
  const cases = [
    [{ state, preset: 'nope' }, 'bad_request', /unknown preset "nope".*triage/],
    [{ state, preset: 7 }, 'bad_request', /preset must be a string/],
    [{ state }, 'bad_request', /questions or a preset|must be an object/],
    [{ state, questions: {} }, 'bad_request', /at least one question/],
    [{ state, questions: { q: { type: 'nonsense', instructions: 'x' } } }, 'bad_request', /must be "choice", "score" or "noul"/],
    [{ state, questions: { q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } } }, 'bad_request', /at least two options/],
    [{ state, questions: { q: { type: 'score', instructions: 'x', criteria: 'not a list' } } }, 'bad_request', /ordered array/],
    [{ state, questions: { q: { type: 'choice', instructions: '', criteria: { a: '1', b: '2' } } } }, 'bad_request', /must not be empty/],
    [{ state: 42, preset: 'triage' }, 'bad_request', /state must be an object or a string/],
    [null, 'bad_request', /request body is required/]
  ];
  for (const [body, code, re] of cases) {
    const r = await s.decide(body);
    ok('rejects ' + JSON.stringify(body).slice(0, 52) + ' as ' + code,
       r.ok === false && r.code === code && re.test(r.error), (r.code ?? '?') + ': ' + (r.error ?? ''));
  }
  ok('a rejected request never reaches the model', s.health().calls === 0);
}

section('presets can be derived from the state');
{
  const seen = [];
  const s = createLayaServer({
    presets: {
      dynamic: (st) => {
        seen.push(st);
        return { pick: choice('Which region?', st.regions) };
      }
    },
    load: async () => fakeModel()
  });
  const r = await s.decide({ state: { regions: ['emea', 'apac'] }, preset: 'dynamic' });
  ok('the preset function receives the state', seen.length === 1 && seen[0].regions.length === 2);
  ok('its questions are used', r.ok === true && ['emea', 'apac'].includes(r.answers.pick.choice), JSON.stringify(r.answers));

  const throwing = createLayaServer({ presets: { bad: () => { throw new Error('boom'); } }, load: async () => fakeModel() });
  const r2 = await throwing.decide({ state, preset: 'bad' });
  ok('a throwing preset is an internal error, not a crash', r2.ok === false && r2.code === 'internal' && /boom/.test(r2.error), r2.error);

  const invalid = createLayaServer({ presets: { bad: () => ({ q: { type: 'choice' } }) }, load: async () => fakeModel() });
  const r3 = await invalid.decide({ state, preset: 'bad' });
  ok('a preset producing invalid questions is caught', r3.ok === false && r3.code === 'internal', r3.code + ': ' + r3.error);
}

section('the context window is respected');
{
  const big = { blob: 'x'.repeat(8000), keep: 'important' };
  const s = createLayaServer({ presets: { triage }, load: async () => fakeModel() });
  const r = await s.decide({ state: big, preset: 'triage' });
  ok('an oversized prompt is refused rather than truncated', r.ok === false && r.code === 'too_large', r.code);
  ok('the refusal names the budget and the context', /token budget/.test(r.error) && /512-token context/.test(r.error), r.error);
  ok('it never reached the model', s.health().calls === 0);

  const trimming = createLayaServer({
    presets: { triage },
    fit: { dropStateKeys: ['blob'] },
    load: async () => fakeModel()
  });
  const r2 = await trimming.decide({ state: big, preset: 'triage' });
  ok('with fit configured it trims and proceeds', r2.ok === true, JSON.stringify(r2).slice(0, 110));
  ok('what was trimmed is reported', r2.trimmed?.some((t) => /blob/.test(t)), JSON.stringify(r2.trimmed));
  ok('the trimmed prompt is within budget', r2.tokens <= 435, String(r2.tokens));

  const hopeless = createLayaServer({
    presets: { triage }, fit: { dropStateKeys: ['nothing'] }, load: async () => fakeModel()
  });
  const r3 = await hopeless.decide({ state: big, preset: 'triage' });
  ok('an untrimmable prompt is still refused', r3.ok === false && r3.code === 'too_large', r3.code);
  ok('the multilingual context allows a bigger prompt',
     (await createLayaServer({ presets: { triage }, context: 'multilingual', load: async () => fakeModel() })
        .decide({ state: { blob: 'x'.repeat(2400) }, preset: 'triage' })).ok === true);
}

section('model and inference failures');
{
  const missing = createLayaServer({ presets: { triage }, load: async () => { throw new Error('@receptron/laya is not installed'); } });
  const r = await missing.decide({ state, preset: 'triage' });
  ok('a missing model is unavailable, not a crash', r.ok === false && r.code === 'unavailable', r.code);
  ok('the load error is surfaced', /not installed/.test(r.error), r.error);
  ok('health reports the reason', missing.health().engine === 'unavailable' && /not installed/.test(missing.health().reason ?? ''));
  const r2 = await missing.decide({ state, preset: 'triage' });
  ok('it retries rather than caching the failure forever', r2.ok === false && r2.code === 'unavailable');

  const broken = createLayaServer({ presets: { triage }, load: async () => fakeModel({ fail: 'onnx session died' }) });
  const r3 = await broken.decide({ state, preset: 'triage' });
  ok('an inference error is internal', r3.ok === false && r3.code === 'internal' && /onnx session died/.test(r3.error), r3.error);

  const garbage = createLayaServer({ presets: { triage }, load: async () => fakeModel({ garbage: true }) });
  const r4 = await garbage.decide({ state, preset: 'triage' });
  ok('a response with no answers is internal', r4.ok === false && r4.code === 'internal' && /no answers/.test(r4.error), r4.error);
}

section('one forward pass at a time');
{
  const model = fakeModel({ delay: 25 });
  const s = createLayaServer({ presets: { triage }, load: async () => model });
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => s.decide({ state, preset: 'triage' })));
  ok('all five decisions succeed', all.every((r) => r.ok === true));
  ok('inference never overlapped', model.stats.maxConcurrent === 1, String(model.stats.maxConcurrent));
  ok('the model was called once per decision', model.stats.calls.length === 5);
  ok('all five are counted', s.health().calls === 5);

  const limited = createLayaServer({ presets: { triage }, maxQueue: 2, load: async () => fakeModel({ delay: 40 }) });
  await limited.warmup();
  const burst = await Promise.all(Array.from({ length: 6 }, () => limited.decide({ state, preset: 'triage' })));
  const rejected = burst.filter((r) => !r.ok);
  ok('a queue limit sheds load instead of piling up', rejected.length > 0, String(rejected.length));
  ok('shed requests say why', rejected.every((r) => r.code === 'unavailable' && /in flight/.test(r.error)),
     rejected[0] ? rejected[0].error : '');
}

section('warmup and close');
{
  const model = fakeModel();
  const s = createLayaServer({ presets: { triage }, load: async () => model });
  const h = await s.warmup();
  ok('warmup loads the model', h.engine === 'laya');
  await s.decide({ state, preset: 'triage' });
  ok('an injected stub is never reported as laya', s.health().model === 'laya-english', String(s.health().model));
  await s.close();
  ok('close releases the session', model.stats.closed === true);
  ok('health goes back to unavailable after close', s.health().engine === 'unavailable');

  const failing = createLayaServer({ load: async () => { throw new Error('nope'); } });
  const h2 = await failing.warmup();
  ok('warmup resolves even when loading fails', h2.engine === 'unavailable' && /nope/.test(h2.reason ?? ''));
}

section('the node http handler');
{
  const s = createLayaServer({ presets: { triage }, load: async () => fakeModel(), cors: '*' });
  const server = http.createServer((req, res) => s.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const hr = await fetch(base + '/laya/health');
    const hb = await hr.json();
    ok('GET health works', hr.status === 200 && hb.presets[0] === 'triage');
    ok('cors is applied when configured', hr.headers.get('access-control-allow-origin') === '*');

    const dr = await fetch(base + '/laya/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, preset: 'triage' })
    });
    const db = await dr.json();
    ok('POST decide works', dr.status === 200 && db.ok === true && db.answers.department.choice === 'billing');

    const forbidden = await fetch(base + '/laya/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, questions: triage })
    });
    ok('forbidden maps to HTTP 403', forbidden.status === 403, String(forbidden.status));

    const unknown = await fetch(base + '/laya/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, preset: 'nope' })
    });
    ok('bad_request maps to HTTP 400', unknown.status === 400, String(unknown.status));

    const badJson = await fetch(base + '/laya/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops'
    });
    ok('malformed json maps to HTTP 400', badJson.status === 400);
    ok('and explains itself', /valid JSON/.test((await badJson.json()).error));

    const huge = await fetch(base + '/laya/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { x: 'y'.repeat(300_000) }, preset: 'triage' })
    });
    ok('an oversized body maps to HTTP 413', huge.status === 413, String(huge.status));

    ok('GET on decide is 405', (await fetch(base + '/laya/decide')).status === 405);
    ok('an unknown path is 404', (await fetch(base + '/nope')).status === 404);
    const pre = await fetch(base + '/laya/decide', { method: 'OPTIONS' });
    ok('preflight is answered', pre.status === 204 && pre.headers.get('access-control-allow-methods') !== null);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const noCors = createLayaServer({ presets: { triage }, load: async () => fakeModel() });
  const server2 = http.createServer((req, res) => noCors.handler(req, res));
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch('http://127.0.0.1:' + server2.address().port + '/laya/health');
    ok('no cors header unless asked for', res.headers.get('access-control-allow-origin') === null);
  } finally {
    await new Promise((r) => server2.close(r));
  }
}

section('the fetch handler (next.js, hono, bun)');
{
  const s = createLayaServer({ presets: { triage }, allowAdHoc: true, load: async () => fakeModel() });
  const health = await s.fetchHandler(new Request('https://app.test/laya/health'));
  ok('health responds', health.status === 200 && (await health.json()).engine !== undefined);

  const decided = await s.fetchHandler(new Request('https://app.test/laya/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, preset: 'triage' })
  }));
  const body = await decided.json();
  ok('decide responds', decided.status === 200 && body.ok === true);
  ok('the content type is json', /application\/json/.test(decided.headers.get('content-type')));

  const bad = await s.fetchHandler(new Request('https://app.test/laya/decide', { method: 'POST', body: 'nope' }));
  ok('malformed json is 400', bad.status === 400);
  const wrongMethod = await s.fetchHandler(new Request('https://app.test/laya/decide'));
  ok('GET is 405', wrongMethod.status === 405);
  const preflight = await s.fetchHandler(new Request('https://app.test/laya/decide', { method: 'OPTIONS' }));
  ok('preflight is 204', preflight.status === 204);
}

summary();
