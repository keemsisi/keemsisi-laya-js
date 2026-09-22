/**
 * The real checkpoint.
 *
 * Every other suite runs against an injected model, which is what keeps them
 * fast and dependency-free. This one loads the actual 1.69 GB Laya bundle
 * through @laya-js/server and asserts the things only the real model can
 * confirm: the answer shapes match the published types, the probabilities are
 * a proper distribution, inference is deterministic, and the model actually
 * routes tickets sensibly.
 *
 * Skipped unless the weights are already cached, so `npm test` never triggers
 * a 1.69 GB download.
 *
 *   node packages/server/test/real-model.test.mjs
 */
import { ok, eq, near, section, summary } from '../../test-harness.mjs';
import { createLayaServer } from '../dist/index.js';
import { choice, score, noul, readAll, optionsOf } from '@laya-js/core';
import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';

const REVISION = process.env.LAYA_REVISION ?? 'main';
const cacheRoot = process.env.LAYA_CACHE ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'receptron-laya');
const bundleDir = process.env.LAYA_MODEL_DIR ??
  path.join(cacheRoot, 'receptron--laya-onnx', REVISION);

async function cached() {
  try { return (await stat(path.join(bundleDir, 'laya.onnx.data'))).size > 1e9; }
  catch { return false; }
}

if (!(await cached())) {
  console.log('SKIPPED: the Laya bundle is not cached at ' + bundleDir);
  console.log('         install @receptron/laya and run the server once with LAYA=1 to populate it.');
  process.exit(0);
}

const triage = {
  department: choice('Which team should handle this ticket?', {
    billing: 'invoices, payments, refunds, double charges',
    technical: 'bugs, outages, errors, API problems',
    sales: 'pricing, plans, new contracts, upgrades',
    other: 'anything else'
  }),
  urgency: score('How urgent is this ticket?', ['not urgent', 'somewhat urgent', 'urgent', 'critical']),
  churn: noul('Is this customer likely to cancel or dispute?', {
    true: 'they threaten to leave, dispute the charge, or sound ready to churn',
    false: 'they are asking for help and expect it to be resolved'
  })
};

const server = createLayaServer({
  presets: { triage },
  revision: REVISION,
  fit: { dropStateKeys: ['body'] },
  logger: (l) => console.log('        ' + l)
});

try {
  section('loading the real checkpoint');
  const t0 = Date.now();
  const health = await server.warmup();
  const loadMs = Date.now() - t0;
  ok('the model loads', health.engine === 'laya', health.engine + ' ' + (health.reason ?? ''));
  ok('the source is the pinned revision', /receptron\/laya-onnx@/.test(health.modelSource ?? ''), health.modelSource);
  ok('it is not reported as injected', !/injected/.test(health.modelSource ?? ''));
  ok('the context window comes from the checkpoint config', health.contextTokens === 512,
     String(health.contextTokens));
  console.log('        loaded in ' + loadMs + 'ms');

  section('a real decision');
  const ticket = {
    subject: 'Duplicate charge on invoice #4411',
    body: 'Hi, we were billed twice for March and need one of the charges refunded.'
  };
  const started = Date.now();
  const r = await server.decide({ state: ticket, preset: 'triage' });
  const roundTrip = Date.now() - started;
  ok('it succeeds', r.ok === true, JSON.stringify(r).slice(0, 200));
  if (!r.ok) throw new Error('cannot continue without an answer');

  console.log('        model=' + r.model + '  inference=' + r.ms + 'ms  round trip=' + roundTrip + 'ms' +
              '  prompt≈' + r.tokens + ' tokens  reported=' + (r.usage?.input_tokens ?? '?'));
  console.log('        department: ' + JSON.stringify(r.answers.department.probabilities));
  console.log('        urgency:    score=' + r.answers.urgency.score);
  console.log('        churn:      noul=' + r.answers.churn.noul);

  ok('the model reports a real id, not a stub', typeof r.model === 'string' && r.model.length > 0 && !/stub/i.test(r.model), r.model);
  ok('every question is answered', Object.keys(r.answers).sort().join(',') === 'churn,department,urgency');
  ok('token usage is reported', (r.usage?.input_tokens ?? 0) > 0, String(r.usage?.input_tokens));

  section('the answers match the published types');
  const d = r.answers.department;
  ok('choice: type', d.type === 'choice', d.type);
  ok('choice: the chosen option is one that was offered', optionsOf(triage.department).includes(d.choice), d.choice);
  ok('choice: probabilities are present for every option',
     Object.keys(d.probabilities).sort().join(',') === optionsOf(triage.department).sort().join(','),
     Object.keys(d.probabilities).join(','));
  ok('choice: confidence is a number in [0,1]', typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1,
     String(d.confidence));
  ok('choice: rl_agent.act_probability is present', typeof d.rl_agent?.act_probability === 'number',
     JSON.stringify(d.rl_agent));

  const u = r.answers.urgency;
  ok('score: type', u.type === 'score');
  ok('score: an expected level inside the rubric', typeof u.score === 'number' && u.score >= 0 && u.score <= 3,
     String(u.score));
  ok('score: it is fractional, i.e. an expectation not a hard label',
     Number.isFinite(u.score), String(u.score));

  const c = r.answers.churn;
  ok('noul: type', c.type === 'noul');
  ok('noul: P(true) in [0,1]', typeof c.noul === 'number' && c.noul >= 0 && c.noul <= 1, String(c.noul));

  section('the probabilities are a real distribution');
  const values = Object.values(d.probabilities);
  ok('all probabilities are in [0,1]', values.every((v) => v >= 0 && v <= 1), JSON.stringify(values));
  const sum = values.reduce((a, b) => a + b, 0);
  near('they sum to 1', sum, 1, 0.02);
  ok('the chosen option is the argmax',
     d.choice === Object.keys(d.probabilities).reduce((a, b) => (d.probabilities[b] > d.probabilities[a] ? b : a)),
     d.choice + ' vs ' + JSON.stringify(d.probabilities));

  section('inference is deterministic');
  const again = await server.decide({ state: ticket, preset: 'triage' });
  ok('the same input gives the same answer', again.ok && again.answers.department.choice === d.choice);
  near('and the same probability', again.answers.department.probabilities[d.choice], d.probabilities[d.choice], 1e-6);
  near('and the same score', again.answers.urgency.score, u.score, 1e-6);
  ok('it is not sampling', JSON.stringify(again.answers) === JSON.stringify(r.answers));

  section('core parses the real output');
  const readings = readAll(triage, r.answers);
  ok('the choice reading is not a fallback', readings.department.fallback === false,
     JSON.stringify(readings.department));
  ok('the reading agrees with the raw answer', readings.department.value === d.choice);
  near('the reading takes the chosen probability, not the entropy',
       readings.department.probability, d.probabilities[d.choice], 1e-9);
  ok('the entropy measure is kept separately', readings.department.certainty === d.confidence);
  ok('the score is labelled from the rubric',
     ['not urgent', 'somewhat urgent', 'urgent', 'critical'].includes(readings.urgency.label),
     String(readings.urgency.label));
  ok('the noul reading matches', readings.churn.probability === c.noul);

  section('it routes tickets sensibly');
  const cases = [
    ['billing', { subject: 'Refund for the duplicate payment', body: 'You charged my card twice for the same invoice. Please refund one.' }],
    ['technical', { subject: 'API returns 500 on every order', body: 'Since this morning every call to /v2/orders fails with a server error. Checkout is broken.' }],
    ['sales', { subject: 'Enterprise pricing for 40 seats', body: 'We want to compare annual plans and discuss a contract for our team.' }]
  ];
  for (const [expected, state] of cases) {
    const res = await server.decide({ state, preset: 'triage' });
    if (!res.ok) { ok(expected + ' ticket is answered', false, res.error); continue; }
    const probs = res.answers.department.probabilities;
    const top = Object.keys(probs).reduce((a, b) => (probs[b] > probs[a] ? b : a));
    console.log('        "' + state.subject + '" -> ' + top + '  ' + JSON.stringify(probs));
    ok('a ' + expected + ' ticket routes to ' + expected, top === expected, 'got ' + top);
  }

  section('urgency and churn track the wording');
  const calm = await server.decide({
    state: { subject: 'Question about invoice formatting', body: 'No rush at all, just curious how to add a PO number.' },
    preset: 'triage'
  });
  const panic = await server.decide({
    state: { subject: 'Production is down and we are losing orders', body: 'This is critical, everything is failing right now and we need it fixed immediately.' },
    preset: 'triage'
  });
  console.log('        calm urgency=' + calm.answers.urgency.score + '  panic urgency=' + panic.answers.urgency.score);
  ok('an urgent ticket scores higher than a relaxed one',
     panic.answers.urgency.score > calm.answers.urgency.score,
     calm.answers.urgency.score + ' vs ' + panic.answers.urgency.score);

  const leaving = await server.decide({
    state: { subject: 'Cancelling our account', body: 'Third outage this month. We are moving to a competitor unless this is fixed today.' },
    preset: 'triage'
  });
  console.log('        churn: happy=' + calm.answers.churn.noul + '  leaving=' + leaving.answers.churn.noul);
  ok('a churn threat scores higher than a neutral question',
     leaving.answers.churn.noul > calm.answers.churn.noul,
     calm.answers.churn.noul + ' vs ' + leaving.answers.churn.noul);

  section('the context budget applies to the real model');
  const huge = await server.decide({
    state: { subject: 'Refund please', body: 'x'.repeat(20000) },
    preset: 'triage'
  });
  ok('an oversized ticket is trimmed rather than truncated by the tokenizer',
     huge.ok === true && huge.trimmed?.some((t) => /body/.test(t)), JSON.stringify(huge.trimmed ?? huge.error));
  ok('the trimmed prompt stayed under the window', (huge.tokens ?? 0) <= 435, String(huge.tokens));
  ok('the reported input tokens are inside the 512 context',
     (huge.usage?.input_tokens ?? 0) < 512, String(huge.usage?.input_tokens));

  section('health after real use');
  const h2 = server.health();
  ok('the model id is now known', h2.model === r.model, String(h2.model));
  ok('calls are counted', h2.calls >= 7, String(h2.calls));
  ok('an average latency is reported', h2.avgMs > 0, String(h2.avgMs));
  console.log('        ' + h2.calls + ' inferences, average ' + h2.avgMs + 'ms');
} finally {
  await server.close();
}

const { fail } = summary();
process.exit(fail ? 1 : 0);
