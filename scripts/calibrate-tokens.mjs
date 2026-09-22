import { Laya } from '@receptron/laya';
const laya = await Laya.load({ revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868' });
console.log('loaded, max_len =', laya.config.max_len);

const choice = (instr, opts) => ({ type: 'choice', instructions: instr, criteria: opts });
const mk = (n, len) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [String.fromCharCode(97 + i), 'x'.repeat(len)])
);

function textChars(state, questions) {
  let c = 0;
  for (const [k, v] of Object.entries(state)) c += k.length + String(v).length;
  for (const [k, q] of Object.entries(questions)) {
    c += k.length + String(q.instructions).length;
    const cr = q.criteria;
    if (Array.isArray(cr)) for (const x of cr) c += String(x).length;
    else if (cr) for (const [k2, v2] of Object.entries(cr)) c += k2.length + String(v2 ?? '').length;
  }
  return c;
}

const cases = [
  ['A  1q  2opt  short state', { s: 'hi' }, { q: choice('pick', mk(2, 4)) }],
  ['B  1q  4opt  short state', { s: 'hi' }, { q: choice('pick', mk(4, 4)) }],
  ['C  1q  8opt  short state', { s: 'hi' }, { q: choice('pick', mk(8, 4)) }],
  ['D  1q  2opt  +400 chars ', { s: 'y'.repeat(400) }, { q: choice('pick', mk(2, 4)) }],
  ['E  1q  2opt  +800 chars ', { s: 'y'.repeat(800) }, { q: choice('pick', mk(2, 4)) }],
  ['F  1q  2opt  100ch opts ', { s: 'hi' }, { q: choice('pick', mk(2, 100)) }],
  ['G  3q  mixed            ', { s: 'hi' }, {
    q1: choice('pick', mk(4, 4)),
    q2: { type: 'score', instructions: 'rate', criteria: ['low', 'mid', 'high', 'top'] },
    q3: { type: 'noul', instructions: 'true?' }
  }]
];

const rows = [];
for (const [label, state, questions] of cases) {
  const r = await laya.systemOne(state, questions);
  const chars = textChars(state, questions);
  const opts = Object.values(questions).reduce((a, q) =>
    a + (Array.isArray(q.criteria) ? q.criteria.length : Object.keys(q.criteria ?? {}).length || 2), 0);
  rows.push({ label, chars, questions: Object.keys(questions).length, opts, tokens: r.usage.input_tokens });
  console.log(`${label}  chars=${String(chars).padStart(5)}  q=${Object.keys(questions).length}  opts=${String(opts).padStart(2)}  REAL_TOKENS=${r.usage.input_tokens}`);
}

// Solve roughly: tokens ~= base + chars/cpt + perQ*q + perOpt*opts
const A = rows[0], B = rows[1], C = rows[2], D = rows[3], E = rows[4], F = rows[5], G = rows[6];
console.log('\nper extra option (B-A)/2      =', ((B.tokens - A.tokens) / 2).toFixed(2));
console.log('per extra option (C-B)/4      =', ((C.tokens - B.tokens) / 4).toFixed(2));
console.log('chars per token, state (D-A)  =', ((D.chars - A.chars) / (D.tokens - A.tokens)).toFixed(2));
console.log('chars per token, state (E-D)  =', ((E.chars - D.chars) / (E.tokens - D.tokens)).toFixed(2));
console.log('chars per token, options (F-A)=', ((F.chars - A.chars) / (F.tokens - A.tokens)).toFixed(2));
console.log('per extra question (G vs B)   =', (G.tokens - B.tokens), 'for 2 extra questions + 4 levels');
console.log('baseline A                    =', A.tokens, 'tokens for', A.chars, 'chars');
await laya.close();
