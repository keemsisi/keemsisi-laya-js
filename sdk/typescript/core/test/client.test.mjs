import { ok, eq, section, summary } from '../../../../tools/harness.mjs';
import { createClient, choice, score } from '../dist/index.js';

const questions = { dept: choice('Which team?', { billing: 'refunds', support: 'bugs' }) };
const state = { subject: 'Refund not received' };

function stubFetch(impl) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return impl(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const goodBody = {
  ok: true, engine: 'laya', model: 'laya-english', ms: 33,
  answers: { dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.94, support: 0.06 }, confidence: 0.6 } },
  usage: { input_tokens: 120, output_tokens: 0 }
};

section('a successful decision');
{
  const fetchStub = stubFetch(() => jsonResponse(goodBody));
  const c = createClient({ endpoint: 'http://host:1/', fetch: fetchStub });
  const r = await c.ask(state, questions);
  ok('returns the decision', r.ok === true && r.answers.dept.choice === 'billing');
  ok('reports the engine as laya', r.engine === 'laya' && c.engine === 'laya');
  ok('clears any stale reason', c.reason === null);
  ok('posts to the decide path', fetchStub.calls[0].url === 'http://host:1/laya/decide', fetchStub.calls[0].url);
  ok('uses POST with json', fetchStub.calls[0].init.method === 'POST' &&
     fetchStub.calls[0].init.headers['content-type'] === 'application/json');
  eq('sends state and questions', JSON.parse(fetchStub.calls[0].init.body), { state, questions });
  ok('in-flight returns to zero', c.inFlight === 0);
}

section('request shapes and configuration');
{
  const f = stubFetch(() => jsonResponse(goodBody));
  const c = createClient({ endpoint: '', fetch: f, headers: { authorization: 'Bearer t' }, decidePath: '/api/decide' });
  await c.askPreset(state, 'triage');
  eq('a preset request sends a name, not questions', JSON.parse(f.calls[0].init.body), { state, preset: 'triage' });
  ok('a relative endpoint stays relative', f.calls[0].url === '/api/decide', f.calls[0].url);
  ok('custom headers are merged', f.calls[0].init.headers.authorization === 'Bearer t');

  const bad = await c.decide({ state });
  ok('a request with neither questions nor preset is refused', bad.ok === false && bad.code === 'bad_request', bad.code);
  ok('the refusal costs no network call', f.calls.length === 1, String(f.calls.length));
  const bad2 = await c.decide(null);
  ok('a null request is refused', bad2.ok === false && bad2.code === 'bad_request');
}

section('server-side failures');
{
  const cases = [
    [503, { ok: false, code: 'unavailable', error: 'model not loaded' }, 'unavailable'],
    [400, { ok: false, code: 'bad_request', error: 'unknown preset' }, 'bad_request'],
    [403, { ok: false, code: 'forbidden', error: 'ad-hoc disabled' }, 'forbidden'],
    [413, { ok: false, code: 'too_large', error: 'prompt too large' }, 'too_large'],
    [500, { ok: false, code: 'internal', error: 'boom' }, 'internal']
  ];
  for (const [status, body, expected] of cases) {
    const c = createClient({ fetch: stubFetch(() => jsonResponse(body, status)) });
    const r = await c.decide({ state, questions });
    ok('HTTP ' + status + ' becomes code ' + expected, r.ok === false && r.code === expected, r.code);
    ok('HTTP ' + status + ' keeps the server message', r.ok === false && r.error === body.error, r.error);
  }

  const c2 = createClient({ fetch: stubFetch(() => jsonResponse({ ok: false, code: 'unavailable', error: 'x' }, 503)) });
  await c2.decide({ state, questions });
  ok('an unavailable model updates the client engine', c2.engine === 'unavailable', c2.engine);

  const noCode = createClient({ fetch: stubFetch(() => new Response('gateway down', { status: 502 })) });
  const r2 = await noCode.decide({ state, questions });
  ok('a non-json error still maps to a code', r2.ok === false && r2.code === 'internal', r2.code);

  const weird = createClient({ fetch: stubFetch(() => jsonResponse({ hello: 'world' })) });
  const r3 = await weird.decide({ state, questions });
  ok('a 200 without the ok field is an internal error', r3.ok === false && r3.code === 'internal', r3.code);

  const notJson = createClient({ fetch: stubFetch(() => new Response('<html>', { status: 200 })) });
  const r4 = await notJson.decide({ state, questions });
  ok('a 200 that is not json is an internal error', r4.ok === false && r4.code === 'internal', r4.code);
}

section('transport failures');
{
  const dead = createClient({ fetch: stubFetch(() => { throw new TypeError('fetch failed'); }) });
  const r = await dead.decide({ state, questions });
  ok('a network error is unreachable, not a throw', r.ok === false && r.code === 'unreachable', r.code);
  ok('the reason is recorded', /fetch failed/.test(dead.reason ?? ''), dead.reason);
  ok('the engine is marked unavailable', dead.engine === 'unavailable');

  const hang = createClient({
    timeoutMs: 40,
    fetch: stubFetch((_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason ?? new Error('aborted')));
    }))
  });
  const started = Date.now();
  const r2 = await hang.decide({ state, questions });
  ok('a hanging endpoint times out', r2.ok === false && r2.code === 'timeout', r2.code);
  ok('it gives up near the deadline', Date.now() - started < 1500, String(Date.now() - started));
  ok('the timeout is explained', /within 40ms/.test(r2.error), r2.error);
  ok('in-flight is released after a timeout', hang.inFlight === 0);

  const ac = new AbortController();
  const cancel = createClient({
    // Mirrors real fetch: reject at once if the signal is already aborted,
    // otherwise reject when it fires.
    fetch: stubFetch((_u, init) => new Promise((_res, rej) => {
      if (init.signal.aborted) { rej(new DOMException('aborted', 'AbortError')); return; }
      init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')), { once: true });
    }))
  });
  const p = cancel.decide({ state, questions }, { signal: ac.signal });
  ac.abort();
  const r3 = await p;
  ok('a caller abort is reported as aborted, not a timeout', r3.ok === false && r3.code === 'aborted', r3.code);
  ok('an abort is not blamed on the model', cancel.engine !== 'unavailable', cancel.engine);

  const pre = new AbortController();
  pre.abort();
  const preFetch = stubFetch(() => jsonResponse(goodBody));
  const preClient = createClient({ fetch: preFetch });
  const r4 = await preClient.decide({ state, questions }, { signal: pre.signal });
  ok('an already-aborted signal is handled', r4.ok === false && r4.code === 'aborted', r4.code);
  ok('and costs no network call', preFetch.calls.length === 0, String(preFetch.calls.length));
}

section('health');
{
  const body = {
    engine: 'laya', model: 'convaiinnovations/laya', contextTokens: 512,
    reason: null, presets: ['triage'], allowAdHoc: false, calls: 4, avgMs: 140
  };
  const f = stubFetch(() => jsonResponse(body));
  const c = createClient({ endpoint: 'http://host:1', fetch: f });
  const h = await c.health();
  eq('returns the health body', h, body);
  ok('gets the health path', f.calls[0].url === 'http://host:1/laya/health', f.calls[0].url);
  ok('updates the engine', c.engine === 'laya' && c.reason === null);

  const down = createClient({ fetch: stubFetch(() => { throw new Error('ECONNREFUSED'); }) });
  ok('an unreachable health check returns null', (await down.health()) === null);
  ok('and marks the engine unavailable', down.engine === 'unavailable');
  ok('and records why', /ECONNREFUSED/.test(down.reason ?? ''), down.reason);

  const loading = createClient({ fetch: stubFetch(() => jsonResponse({ engine: 'loading', reason: 'downloading weights' })) });
  await loading.health();
  ok('a loading engine is reported as loading', loading.engine === 'loading' && loading.reason === 'downloading weights');

  const err = createClient({ fetch: stubFetch(() => new Response('nope', { status: 500 })) });
  ok('a 500 health check returns null', (await err.health()) === null);
}

section('no path ever throws');
{
  const nasty = [
    () => { throw new Error('sync throw'); },
    () => Promise.reject(new Error('async reject')),
    () => jsonResponse(null),
    () => new Response('', { status: 204 }),
    () => ({ ok: true, json: async () => { throw new Error('bad json'); }, status: 200 })
  ];
  let threw = null;
  for (const impl of nasty) {
    const c = createClient({ fetch: stubFetch(impl), timeoutMs: 100 });
    try {
      const r = await c.decide({ state, questions });
      if (typeof r?.ok !== 'boolean') threw = 'non-conforming result: ' + JSON.stringify(r);
      const h = await c.health();
      if (h !== null && typeof h !== 'object') threw = 'bad health result';
    } catch (e) { threw = e.message; }
  }
  ok('every hostile transport resolves to a result object', threw === null, threw);
  const noFetch = createClient({ fetch: undefined, endpoint: 'http://x' });
  ok('a missing fetch is reported, not thrown', (await noFetch.decide({ state, questions })).code === 'unreachable');
}

summary();
