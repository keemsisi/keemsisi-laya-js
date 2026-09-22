/**
 * Generate the conformance vectors every native port must reproduce.
 *
 * Reads the reference implementation (@receptron/laya, itself a port of the
 * checkpoint's rl_agent_api.py) and records, for a set of deliberately awkward
 * inputs:
 *
 *   sequences.json  input -> exact token ids + marker offsets   (no model needed)
 *   answers.json    input -> exact answers                      (needs the checkpoint)
 *
 * Usage:  node protocol/tools/gen-conformance.mjs [--answers]
 */
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// The package restricts subpath exports, so reach the internals by file URL.
// These are exactly the functions a port has to match, which is the point.
const repoRoot = new URL('../../', import.meta.url);
const pkgDir = path.join(repoRoot.pathname, 'node_modules/@receptron/laya');
const seq = await import(pathToFileURL(path.join(pkgDir, 'dist/sequence.js')).href);
const { Laya } = await import('@receptron/laya');

const REVISION = process.env.LAYA_REVISION || 'main';
const OUT = new URL('../conformance/', import.meta.url);

/** Deliberately awkward: every branch a port can get wrong. */
const CASES = [
  { name: 'choice-with-descriptions', state: { subject: 'Duplicate charge', body: 'Billed twice for March.' },
    questions: { dept: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'refunds and invoices', support: 'bugs' } } } },

  { name: 'choice-from-a-list', state: 'a plain string state',
    questions: { pick: { type: 'choice', instructions: 'Pick one', criteria: ['alpha', 'beta', 'gamma'] } } },

  { name: 'choice-with-null-description', state: { s: 'x' },
    questions: { pick: { type: 'choice', instructions: 'Pick', criteria: { a: null, b: 'has a description' } } } },

  { name: 'score-rubric', state: { ticket: 'Production is down.' },
    questions: { urgency: { type: 'score', instructions: 'How urgent?', criteria: ['not urgent', 'somewhat', 'urgent', 'critical'] } } },

  { name: 'noul-defaults', state: { s: 'The customer threatens to leave.' },
    questions: { churn: { type: 'noul', instructions: 'Likely to cancel?' } } },

  { name: 'noul-custom-criteria', state: { s: 'All good, just a question.' },
    questions: { churn: { type: 'noul', instructions: 'Likely to cancel?', criteria: { true: 'they threaten to leave', false: 'they are asking for help' } } } },

  // Python's json.dumps: ", " and ": " separators, insertion order, literal non-ASCII.
  { name: 'state-object-key-order-and-unicode', state: { zeta: 1, alpha: 'éàü 中文', nested: { b: [1, 2, { c: null }], a: true } },
    questions: { q: { type: 'choice', instructions: 'Which?', criteria: { x: 'one', y: 'two' } } } },

  { name: 'literal-mask-token-is-scrubbed', state: { s: 'contains [MASK] in the state' },
    questions: { q: { type: 'choice', instructions: 'has [MASK] here too', criteria: { a: 'and [MASK] in an option', b: 'clean' } } } },

  { name: 'many-options-temperature-bucket', state: { s: 'pick a letter' },
    questions: { q: { type: 'choice', instructions: 'Which letter?',
      criteria: Object.fromEntries('abcdefghijklm'.split('').map((c) => [c, 'letter ' + c])) } } },

  { name: 'long-instructions-truncated', state: { s: 'short' },
    questions: { q: { type: 'choice', instructions: 'why '.repeat(400).trim(), criteria: { a: 'one', b: 'two' } } } },

  { name: 'long-options-force-even-shrink', state: { s: 'short' },
    questions: { q: { type: 'choice', instructions: 'Pick',
      criteria: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['o' + i, ('description ' + i + ' ').repeat(40)])) } } },

  { name: 'long-state-truncated', state: { body: 'The customer was billed twice. '.repeat(120) },
    questions: { q: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'refunds', support: 'bugs' } } } },

  { name: 'batch-of-three', state: { subject: 'Refund not received', body: 'Cancelled two weeks ago.' },
    questions: {
      dept: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'refunds', technical: 'bugs', sales: 'pricing' } },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high', 'critical'] },
      churn: { type: 'noul', instructions: 'Likely to cancel?' }
    } }
];

const cacheRoot = process.env.LAYA_CACHE ||
  path.join(process.env.HOME, '.cache', 'receptron-laya');
const modelDir = process.env.LAYA_MODEL_DIR || path.join(cacheRoot, 'receptron--laya-onnx', REVISION);

const config = JSON.parse(await readFile(path.join(modelDir, 'laya_config.json'), 'utf8'));
const tokJson = JSON.parse(await readFile(path.join(modelDir, 'tokenizer/tokenizer.json'), 'utf8'));
const tokCfg = JSON.parse(await readFile(path.join(modelDir, 'tokenizer/tokenizer_config.json'), 'utf8'));
const { Tokenizer } = await import('@huggingface/tokenizers');
const tok = new Tokenizer(tokJson, tokCfg);
const id = (t) => tok.token_to_id(t);
const ids = { cls: id('[CLS]'), sep: id('[SEP]'), mask: id('[MASK]'), pad: id('[PAD]'), maskTok: '[MASK]' };
const encode = (text) => tok.encode(text, { add_special_tokens: false }).ids;

await mkdir(OUT, { recursive: true });

// ---- sequences: no model required, so any port can check itself offline ----
const sequences = {
  note: 'Generated from @receptron/laya. A port is correct when it reproduces ids and markers exactly. See protocol/SPEC.md.',
  revision: REVISION,
  config: { max_len: config.max_len, head_max_len: config.head_max_len },
  specialTokens: { cls: ids.cls, sep: ids.sep, mask: ids.mask, pad: ids.pad },
  cases: CASES.map((c) => ({
    name: c.name,
    state: c.state,
    questions: c.questions,
    expected: Object.fromEntries(Object.entries(c.questions).map(([qid, q]) => {
      const internal = seq.toInternal(q);
      const built = seq.buildSequence(encode, ids, c.state, internal, config.max_len, config.head_max_len);
      return [qid, {
        renderedOptions: seq.renderOptions(internal),
        qtype: seq.QTYPES[internal.t],
        temperatureBucket: seq.tempBucket(seq.QTYPES[internal.t], built.markers.length),
        tokenCount: built.ids.length,
        markers: built.markers,
        ids: built.ids
      }];
    }))
  }))
};
await writeFile(new URL('sequences.json', OUT), JSON.stringify(sequences, null, 2) + '\n');
console.log('sequences.json: %d cases', sequences.cases.length);

// also pin the state serialiser, since Python's json.dumps is the easy thing to get wrong
const serialisation = {
  note: "Python json.dumps(obj, ensure_ascii=False): ', ' and ': ' separators, insertion order, literal non-ASCII.",
  cases: [
    { in: 'already a string', out: seq.serializeState('already a string') },
    { in: { b: 1, a: 2 }, out: seq.serializeState({ b: 1, a: 2 }) },
    { in: { s: 'é à ü 中文' }, out: seq.serializeState({ s: 'é à ü 中文' }) },
    { in: { n: [1, 2.5, null, true, false] }, out: seq.serializeState({ n: [1, 2.5, null, true, false] }) },
    { in: { nested: { x: { y: 'z' } } }, out: seq.serializeState({ nested: { x: { y: 'z' } } }) },
    { in: { empty: {}, list: [] }, out: seq.serializeState({ empty: {}, list: [] }) }
  ]
};
await writeFile(new URL('state-serialisation.json', OUT), JSON.stringify(serialisation, null, 2) + '\n');
console.log('state-serialisation.json: %d cases', serialisation.cases.length);

if (!process.argv.includes('--answers')) {
  console.log('\nskipping answers.json (pass --answers to load the checkpoint)');
  process.exit(0);
}

const laya = await Laya.load({ modelDir });
const answers = { note: 'End-to-end vectors. Reproduce these and your port is interchangeable.', revision: REVISION, cases: [] };
for (const c of CASES) {
  const r = await laya.systemOne(c.state, c.questions);
  answers.cases.push({ name: c.name, state: c.state, questions: c.questions, expected: r });
  console.log('  %s -> %d answer(s), %d input tokens', c.name, Object.keys(r.answers).length, r.usage.input_tokens);
}
await laya.close();
await writeFile(new URL('answers.json', OUT), JSON.stringify(answers, null, 2) + '\n');
console.log('answers.json: %d cases', answers.cases.length);
