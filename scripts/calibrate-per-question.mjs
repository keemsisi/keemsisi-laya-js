import { Laya } from '@receptron/laya';
const laya = await Laya.load({ revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868' });

const opt = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String.fromCharCode(97 + i), 'alpha beta gamma']));
const q = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [
  'q' + i, { type: 'choice', instructions: 'Which one should be chosen here?', criteria: opt(2) }
]));

// Real English, so the tokenizer behaves as it would in production.
const sentence = 'The customer was billed twice for the March invoice and is asking for a refund of the duplicate charge. ';
const longState = { body: sentence.repeat(4) };          // ~412 chars
const manyFields = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['f' + i, sentence.slice(0, 80)]));

const cases = [
  ['1 question,  long state (1 field) ', longState, q(1)],
  ['2 questions, long state (1 field) ', longState, q(2)],
  ['3 questions, long state (1 field) ', longState, q(3)],
  ['1 question,  tiny state           ', { s: 'hi' }, q(1)],
  ['3 questions, tiny state           ', { s: 'hi' }, q(3)],
  ['1 question,  5 state fields       ', manyFields, q(1)],
  ['3 questions, 5 state fields       ', manyFields, q(3)]
];

for (const [label, state, questions] of cases) {
  const r = await laya.systemOne(state, questions);
  const chars = Object.entries(state).reduce((a, [k, v]) => a + k.length + String(v).length, 0);
  console.log(`${label} stateChars=${String(chars).padStart(4)}  q=${Object.keys(questions).length}  REAL=${r.usage.input_tokens}`);
}
await laya.close();
