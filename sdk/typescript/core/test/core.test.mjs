import { ok, eq, near, section, summary } from '../../../../tools/harness.mjs';
import * as L from '../dist/index.js';

section('question builders');
{
  const c = L.choice('Which team?', { billing: 'refunds', support: 'bugs' });
  eq('choice from a record', c, { type: 'choice', instructions: 'Which team?', criteria: { billing: 'refunds', support: 'bugs' } });
  const c2 = L.choice('Pick', ['a', 'b']);
  eq('choice from a list', c2.criteria, ['a', 'b']);
  eq('optionsOf reads a record', L.optionsOf(c), ['billing', 'support']);
  eq('optionsOf reads a list', L.optionsOf(c2), ['a', 'b']);

  const s = L.score('How urgent?', ['low', 'high']);
  eq('score keeps the rubric order', s.criteria, ['low', 'high']);
  let threw = null;
  try { L.score('bad', ['only one']); } catch (e) { threw = e; }
  ok('score rejects a one-level rubric', threw instanceof TypeError, String(threw));

  eq('noul without criteria', L.noul('Likely to churn?'), { type: 'noul', instructions: 'Likely to churn?' });
  ok('noul with criteria', L.noul('x', { true: 'yes side' }).criteria.true === 'yes side');

  const src = { a: 'x' };
  const built = L.choice('i', src);
  src.a = 'mutated';
  ok('builders copy their criteria', built.criteria.a === 'x', built.criteria.a);
}

section('reading a choice answer');
{
  // The exact ChoiceAnswer shape from @receptron/laya's published types.
  const answer = {
    type: 'choice', choice: 'billing',
    probabilities: { billing: 0.9415, support: 0.031, sales: 0.0275 },
    confidence: 0.62, rl_agent: { act_probability: 0.9 }
  };
  const r = L.readChoice(answer, { allowed: ['billing', 'support', 'sales'] });
  ok('reads the choice', r.value === 'billing');
  near('probability is the chosen option', r.probability, 0.9415);
  near('certainty is the entropy measure', r.certainty, 0.62);
  ok('probability and certainty are not confused', r.probability !== r.certainty);
  ok('not a fallback', r.fallback === false);
  eq('probabilities pass through', r.probabilities, answer.probabilities);

  const invented = L.readChoice({ type: 'choice', choice: 'legal', probabilities: { billing: 1 }, confidence: 1 },
                                { allowed: ['billing', 'support'] });
  ok('an option that was not offered falls back', invented.value === 'billing' && invented.fallback === true);
  ok('a fallback reports zero probability', invented.probability === 0);

  const inferred = L.readChoice({ type: 'choice', probabilities: { a: 0.2, b: 0.75, c: 0.05 }, confidence: 0.4 });
  ok('the choice is inferred from probabilities when absent', inferred.value === 'b', inferred.value);

  const empty = L.readChoice(undefined, { allowed: ['x', 'y'] });
  ok('a missing answer falls back to the first option', empty.value === 'x' && empty.fallback);
  ok('nothing throws on null', L.readChoice(null).value === '');
  ok('nothing throws on a string', L.readChoice('nope').fallback === true);
  ok('a non-finite probability is ignored', L.readChoice({ choice: 'a', probabilities: { a: NaN } }).probability === 0);
}

section('reading a score answer');
{
  const a = { type: 'score', score: 1.3886, legend: {}, probabilities: { 0: 0.2, 1: 0.4, 2: 0.3, 3: 0.1 }, confidence: 0.4 };
  const r = L.readScore(a, { levels: ['not urgent', 'somewhat', 'urgent', 'critical'] });
  near('keeps the fractional expected level', r.value, 1.3886);
  ok('rounds to the nearest level', r.level === 1, String(r.level));
  ok('labels from the rubric', r.label === 'somewhat', String(r.label));
  ok('not a fallback', r.fallback === false);

  const high = L.readScore({ score: 9 }, { levels: ['a', 'b'] });
  ok('clamps above the rubric', high.level === 1 && high.label === 'b', high.level + '/' + high.label);
  const low = L.readScore({ score: -4 }, { levels: ['a', 'b'] });
  ok('clamps below the rubric', low.level === 0, String(low.level));
  ok('a missing score falls back', L.readScore({}).fallback === true && L.readScore({}).value === 0);
  ok('a custom fallback is used', L.readScore(null, { fallback: 2 }).value === 2);
  ok('no rubric means no label', L.readScore({ score: 1 }).label === null);
}

section('reading a noul answer');
{
  const r = L.readNoul({ type: 'noul', noul: 0.0988, rl_agent: { act_probability: 0.7 } });
  near('reads P(true)', r.probability, 0.0988);
  ok('below the threshold is false', r.isTrue === false);
  ok('above the threshold is true', L.readNoul({ noul: 0.91 }).isTrue === true);
  ok('exactly 0.5 counts as true', L.readNoul({ noul: 0.5 }).isTrue === true);
  ok('a boolean answer is accepted', L.readNoul({ noul: true }).probability === 1);
  ok('alternative field names are accepted', L.readNoul({ probability: 0.8 }).isTrue === true);
  ok('a missing answer falls back to false', L.readNoul(undefined).fallback === true && L.readNoul(undefined).isTrue === false);
}

section('reading a whole result');
{
  const questions = {
    department: L.choice('Which team?', { billing: 'refunds', support: 'bugs' }),
    urgency: L.score('How urgent?', ['low', 'mid', 'high']),
    churn: L.noul('Likely to churn?')
  };
  const answers = {
    department: { type: 'choice', choice: 'support', probabilities: { billing: 0.2, support: 0.8 }, confidence: 0.5 },
    urgency: { type: 'score', score: 2 },
    churn: { type: 'noul', noul: 0.7 }
  };
  const all = L.readAll(questions, answers);
  eq('keys match the questions', Object.keys(all), ['department', 'urgency', 'churn']);
  ok('dispatches by question type',
     all.department.kind === 'choice' && all.urgency.kind === 'score' && all.churn.kind === 'noul');
  ok('the choice reading is bounded by the offered options', all.department.value === 'support');
  ok('the score reading is labelled', all.urgency.label === 'high', String(all.urgency.label));
  ok('missing answers still produce readings', L.readAll(questions, null).department.fallback === true);
}

section('reading answers without their questions');
{
  // A preset client knows the answers but not the questions; Laya's answers
  // carry their own type, so they can still be parsed.
  const answers = {
    dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, support: 0.2 }, confidence: 0.5 },
    urgency: { type: 'score', score: 2.2, probabilities: {} },
    churn: { type: 'noul', noul: 0.77 }
  };
  const r = L.readAnswersByType(answers);
  eq('every answer is read', Object.keys(r), ['dept', 'urgency', 'churn']);
  ok('a choice is recognised by its type', r.dept.kind === 'choice' && r.dept.value === 'billing');
  ok('its probability survives', Math.abs(r.dept.probability - 0.8) < 1e-9);
  ok('a score is recognised', r.urgency.kind === 'score' && Math.abs(r.urgency.value - 2.2) < 1e-9);
  ok('a score has no label without a rubric', r.urgency.label === null);
  ok('a noul is recognised', r.churn.kind === 'noul' && r.churn.isTrue === true);
  ok('an unknown shape does not throw', L.readAnswersByType({ x: { hello: 1 } }).x.fallback === true);
  ok('a score is inferred from its field when type is missing',
     L.readAnswersByType({ x: { score: 1.5 } }).x.kind === 'score');
  ok('a noul is inferred from its field when type is missing',
     L.readAnswersByType({ x: { noul: 0.9 } }).x.kind === 'noul');
  eq('null answers yield nothing', L.readAnswersByType(null), {});
  ok('a choice is not validated without the offered options',
     L.readAnswersByType({ x: { type: 'choice', choice: 'anything', probabilities: { anything: 1 } } }).x.fallback === false);
}

section('confidence gating');
{
  const strong = L.readChoice({ choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.7 }, { allowed: ['a', 'b'] });
  const weak = L.readChoice({ choice: 'a', probabilities: { a: 0.3, b: 0.29, c: 0.41 }, confidence: 0.1 }, { allowed: ['a', 'b', 'c'] });
  ok('a confident choice is accepted', L.gate(strong, 0.34).accepted === true);
  ok('an unsure choice is refused', L.gate(weak, 0.34).accepted === false);
  ok('the refusal explains itself', /below floor/.test(L.gate(weak, 0.34).reason), L.gate(weak, 0.34).reason);
  ok('a fallback reading is never accepted', L.gate(L.readChoice(null), 0).accepted === false);
  ok('the fallback refusal says why', L.gate(L.readChoice(null), 0).reason === 'no usable answer');
  ok('noul readings can be gated', L.gate(L.readNoul({ noul: 0.8 }), 0.75).accepted === true);
  ok('gating uses the probability, not the entropy',
     L.gate(L.readChoice({ choice: 'a', probabilities: { a: 0.9 }, confidence: 0.05 }, { allowed: ['a'] }), 0.5).accepted === true);
}

section('context budgeting');
{
  ok('english context is 512', L.CONTEXT_TOKENS.english === 512);
  ok('multilingual context is 1024', L.CONTEXT_TOKENS.multilingual === 1024);
  ok('the default budget keeps a margin', L.defaultBudget() === 435 && L.defaultBudget() < 512, String(L.defaultBudget()));
  ok('the multilingual budget is larger', L.defaultBudget('multilingual') > L.defaultBudget());

  ok('an empty prompt is zero', L.estimateTokens({}, {}) === 0);
  ok('a state with no questions costs nothing', L.estimateTokens({ a: 'x'.repeat(400) }, {}) === 0);

  // Laya encodes the whole state once per question, so cost scales with
  // questions x state size. Verified against the real checkpoint: token
  // counts scaled exactly 1x/2x/3x for 1/2/3 questions on one state.
  const q1 = { a: L.choice('pick one of these', { x: 'one', y: 'two' }) };
  const q2 = { a: q1.a, b: L.choice('pick again please', { x: 'one', y: 'two' }) };
  const q3 = { a: q1.a, b: q2.b, c: L.choice('and once more now', { x: 'one', y: 'two' }) };
  const st = { body: 'z'.repeat(400) };
  const t1 = L.estimateTokens(st, q1), t2 = L.estimateTokens(st, q2), t3 = L.estimateTokens(st, q3);
  ok('the total scales with the number of questions',
     Math.abs(t2 / t1 - 2) < 0.06 && Math.abs(t3 / t1 - 3) < 0.06, [t1, t2, t3].join(','));

  const br = L.estimateTokenBreakdown(st, q3);
  ok('the breakdown costs each question separately', Object.keys(br.perQuestion).join(',') === 'a,b,c');
  ok('the total is the sum of the questions',
     br.total === Object.values(br.perQuestion).reduce((a, b) => a + b, 0));
  ok('the largest single question is what the window limits',
     br.largest === Math.max(...Object.values(br.perQuestion)) && br.largest < br.total,
     br.largest + ' of ' + br.total);
  ok('estimateContextTokens returns the largest', L.estimateContextTokens(st, q3) === br.largest);
  ok('a bigger state makes every question cost more',
     L.estimateTokenBreakdown({ body: 'z'.repeat(1200) }, q1).largest > br.perQuestion.a);
  ok('more options cost more',
     L.estimateTokenBreakdown({}, { a: L.choice('pick', { p: '1', q: '2', r: '3', s: '4' }) }).largest >
     L.estimateTokenBreakdown({}, { a: L.choice('pick', { p: '1', q: '2' }) }).largest);
  ok('a string state is supported', L.estimateTokens('some text', q1) > 0);

  const state = { ticket: 'short', bulky: 'y'.repeat(4000), notes: 'z'.repeat(600) };
  const questions = { route: L.choice('Where?', { a: 'x'.repeat(300), b: 'y'.repeat(300) }) };
  const under = L.fitToContext({ a: 'tiny' }, questions, { budget: 10_000 });
  eq('nothing is trimmed when it fits', under.trimmed, []);
  ok('the fitted prompt reports its size', under.tokens > 0 && under.overBudget === false);
  ok('it reports both the largest question and the batch total',
     under.tokens <= under.total, under.tokens + ' / ' + under.total);
  ok('the budget is checked per question, not against the batch total',
     L.fitToContext({ a: 'tiny' }, { one: questions.route, two: questions.route },
                    { budget: under.tokens + 5 }).overBudget === false,
     'a second identical question must not push it over');

  // Derived so these thresholds do not need re-tuning when the cost model
  // is refitted: what the prompt costs once the bulky state is gone.
  const afterDrops = L.estimateContextTokens({ ticket: 'short' }, questions);
  // Tight enough that dropping the bulky state is not sufficient, so the
  // last-resort option shortening has to run as well.
  const tight = Math.floor(afterDrops * 0.75);
  const fit = L.fitToContext(state, questions, {
    budget: tight, dropStateKeys: ['bulky', 'notes'], shortenQuestion: 'route', caps: [110, 60]
  });
  ok('it fits the budget', fit.tokens <= tight && fit.overBudget === false,
     fit.tokens + ' budget=' + tight + ' trimmed=' + fit.trimmed.join('|'));
  ok('it drops state keys in the order given', /bulky/.test(fit.trimmed[0]), fit.trimmed.join('|'));
  const dropOnly = L.fitToContext(state, questions, {
    budget: afterDrops + 5, dropStateKeys: ['bulky', 'notes'], shortenQuestion: 'route', caps: [110, 60]
  });
  ok('shortening is a last resort, not a default',
     dropOnly.tokens <= afterDrops + 5 && !dropOnly.trimmed.some(t => /shortened/.test(t)),
     dropOnly.tokens + ' budget=' + (afterDrops + 5) + ' trimmed=' + dropOnly.trimmed.join('|'));
  ok('the untouched options keep their full text', dropOnly.questions.route.criteria.a.length === 300);
  ok('the question survives trimming', Object.keys(fit.questions.route.criteria).join(',') === 'a,b');
  ok('option text was shortened, not removed', fit.questions.route.criteria.a.length <= 110);
  ok('shortening is reported', fit.trimmed.some(t => /options shortened/.test(t)), fit.trimmed.join('|'));

  ok('the original state is untouched', state.bulky.length === 4000 && 'notes' in state);
  ok('the original questions are untouched', questions.route.criteria.a.length === 300);

  const impossible = L.fitToContext({ huge: 'q'.repeat(20000) }, questions, { budget: 50 });
  ok('an unfittable prompt is flagged rather than silently sent', impossible.overBudget === true);
  const keep = L.fitToContext({ keep: 'a'.repeat(3000) }, questions, { budget: 50, dropStateKeys: ['absent'] });
  ok('dropping an absent key is not an error', keep.overBudget === true);
}

summary();
