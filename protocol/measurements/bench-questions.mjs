import { Laya } from '@receptron/laya';
import os from 'node:os';

const threads = Number(process.env.THREADS || 0);
const laya = await Laya.load({
  revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868',
  ...(threads ? { sessionOptions: { intraOpNumThreads: threads } } : {})
});
console.log('cores=' + os.cpus().length + '  intraOpNumThreads=' + (threads || 'default'));

const strategy = {
  type: 'choice',
  instructions: 'Which play style does this well call for right now?',
  criteria: {
    balanced: 'nothing urgent; play efficiently',
    downstack: 'cells are buried; dig them out',
    build_tetris: 'clean and low; keep the last column empty for a four-row clear',
    flatten: 'surface is jagged; even it out',
    survive: 'near the top; clear rows now at any cost'
  }
};
const risk = {
  type: 'score',
  instructions: 'How close is this well to topping out?',
  criteria: ['plenty of room, stack is low', 'getting tall but still comfortable', 'dangerous, few rows left', 'about to top out and lose']
};
const move = {
  type: 'choice',
  instructions: 'Where should the falling piece go? Prefer clearing rows, not burying cells, and a low even stack.',
  criteria: {
    a: 'T turned right in col 1, clears nothing, buries none, peak 5/20, flatter.',
    b: 'T flat in cols 2-4, clears 1 row, buries none, peak 4/20.',
    c: 'T flipped in cols 8-10, clears nothing, buries 1, peak 6/20, rougher.',
    d: 'L turned left in col 1, clears nothing, buries none, peak 5/20, flatter.'
  }
};

const fullState = {
  situation: 'Tetris: a well 10 wide, 20 tall. Full rows clear; the stack must not reach the top.',
  stack: 'Tallest column 4 of 20. 2 cells buried under blocks. Surface roughness 5 (0 is flat). Deepest one-column gap 1. Rightmost column not empty.',
  columns: 'Heights left to right: 3, 4, 4, 4, 4, 4, 4, 4, 4, 2.',
  pieces: 'Falling: T. Next: I, O, S. Held: none (swap available).',
  progress: 'Level 4, 32 rows cleared.'
};
const leanState = {
  stack: 'Tallest column 4 of 20. 2 buried cells. Roughness 5. Deepest gap 1. Last column not empty.',
  columns: 'Heights: 3,4,4,4,4,4,4,4,4,2.',
  pieces: 'Falling T. Next I,O,S. Hold none.'
};

async function bench(label, state, questions, runs = 3) {
  await laya.systemOne(state, questions);                    // warm
  const times = [];
  let tokens = 0;
  for (let i = 0; i < runs; i++) {
    const t = Date.now();
    const r = await laya.systemOne(state, questions);
    times.push(Date.now() - t);
    tokens = r.usage.input_tokens;
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const nq = Object.keys(questions).length;
  console.log(`${label.padEnd(36)} q=${nq}  tokens=${String(tokens).padStart(4)} (${Math.round(tokens / nq)}/q)  avg=${String(avg).padStart(5)}ms  min=${Math.min(...times)}ms`);
  return avg;
}

await bench('full state, 3 questions (current)', fullState, { strategy, risk, move });
await bench('full state, 2 questions (no risk)', fullState, { strategy, move });
await bench('lean state, 3 questions', leanState, { strategy, risk, move });
await bench('lean state, 2 questions', leanState, { strategy, move });
await bench('lean state, move only', leanState, { move });
await bench('lean state, strategy only', leanState, { strategy });
await laya.close();
