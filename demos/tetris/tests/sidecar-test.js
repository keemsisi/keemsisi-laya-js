/* ------------------------------------------------------------------ *
 * sidecar-test.js - the server's own modules, with no model.
 *
 * Before server.mjs was split these paths could only be reached by
 * spawning the process and loading the real 1.69 GB checkpoint, so
 * shedding, caller abandonment and the keep-warm cadence were covered
 * only by the real-model suite. Each module now takes its collaborators
 * as arguments, so the same behaviour is reachable with a fake model in
 * milliseconds.
 *
 * Run with:  node tests/sidecar-test.js
 * ------------------------------------------------------------------ */

const path = require('node:path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (p) => path.join(__dirname, '..', 'server', p);

/* A model host that answers instantly, and can be told to stall or fail. */
function fakeModel(opts) {
  const o = opts || {};
  return {
    facts: {
      state: o.state || 'laya', modelDir: '/fake', revision: 'deadbeef',
      maxLen: 512, modelName: null, reason: o.reason || null, loadMs: 1
    },
    calls: 0,
    ready() { return (o.state || 'laya') === 'laya'; },
    async infer(state, questions) {
      this.calls++;
      if (o.throwOn) throw new Error(o.throwOn);
      if (o.delayMs) await sleep(o.delayMs);
      const answers = {};
      for (const key of Object.keys(questions)) {
        const q = questions[key];
        if (q.type === 'choice') {
          const names = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria);
          const probs = {};
          names.forEach((n, i) => { probs[n] = i === 0 ? 0.7 : 0.3 / Math.max(1, names.length - 1); });
          answers[key] = { type: 'choice', choice: names[0], probabilities: probs, confidence: 0.6 };
        } else if (q.type === 'score') {
          answers[key] = { type: 'score', score: 1.5, legend: {}, probabilities: {} };
        } else {
          answers[key] = { type: 'noul', noul: 0.2 };
        }
      }
      return { model: 'fake-laya', answers, usage: { input_tokens: 123, output_tokens: 0 } };
    },
    observeModelName(raw) { if (raw && raw.model) this.facts.modelName = raw.model; }
  };
}

function snap(over) {
  return Object.assign({
    piece: 'I', queue: ['T', 'O'], hold: null, canHold: true, level: 1, lines: 0, score: 0,
    rows: 20, cols: 10, board: '..........\n#####..###', heights: [4, 4, 4, 4, 4, 2, 4, 3, 4, 4],
    maxHeight: 6, holes: 1, bumpiness: 4, deepestWell: 2, rightColumnEmpty: false,
    strategies: ['balanced', 'downstack', 'build_tetris', 'flatten', 'survive'],
    candidates: [
      { key: 'a', why: 'I flat in cols 6-9, clears 1 row.', cleared: 1, useHold: false, r: 0, x: 5, type: 'I' },
      { key: 'b', why: 'I turned right in col 6, clears nothing.', cleared: 0, useHold: false, r: 1, x: 5, type: 'I' }
    ]
  }, over || {});
}

(async function () {
  const { createScheduler } = await import('file://' + S('scheduler.mjs'));
  const { createKeepWarm } = await import('file://' + S('keepwarm.mjs'));
  const { createPipeline } = await import('file://' + S('pipeline.mjs'));
  const { createStaticServer, readBody } = await import('file://' + S('http.mjs'));

  console.log('\n== the scheduler serialises and refuses ==');
  {
    const s = createScheduler({ maxQueue: 1 });
    const slow = s.run(async () => { await sleep(50); return 'first'; }, { arrivedAt: Date.now() });
    const shed = await s.run(async () => 'second', { arrivedAt: Date.now() });
    ok('a second caller is shed while the lock is held', shed.ok === false && shed.reason === 'saturated', JSON.stringify(shed));
    ok('shedding reports the queue depth', shed.queued === 1, String(shed.queued));
    const first = await slow;
    ok('the holder still completes', first.ok === true && first.value === 'first');
    ok('and reports its own inference time', typeof first.ms === 'number' && first.ms >= 45, String(first.ms));

    let ran = false;
    const gone = await s.run(async () => { ran = true; }, { isAlive: () => false, arrivedAt: Date.now() });
    ok('a departed caller is refused', gone.ok === false && gone.reason === 'abandoned');
    ok('and its work never runs, so the model is not held', ran === false);

    const broke = await s.run(async () => { throw new Error('boom'); }, { arrivedAt: Date.now() });
    ok('a thrown error comes back as a result, not a rejection', broke.ok === false && broke.reason === 'failed');
    ok('the error is carried for the caller to report', broke.error.message === 'boom');

    const after = await s.run(async () => 'ok-again', { arrivedAt: Date.now() });
    ok('a failure does not poison the chain', after.ok === true && after.value === 'ok-again');

    const st = s.stats();
    // Two passes actually completed (the slow one and the retry). A shed
    // request, an abandoned one and one that threw are each refusals or
    // faults, not served calls, so they must not dilute avgMs.
    ok('stats count completed passes only', st.calls === 2, JSON.stringify(st));
    ok('stats count the refusals separately', st.shed === 1 && st.abandoned === 1, JSON.stringify(st));
    ok('the queue drains back to zero', st.queued === 0);
    ok('maxQueue is reported for operators', st.maxQueue === 1);
  }

  console.log('\n== keep-warm backs off, and real traffic revives it ==');
  {
    let passes = 0;
    const kw = createKeepWarm({
      intervalMs: 15, rounds: 3, ready: () => true, busy: () => false,
      warm: async () => { passes++; }
    });
    kw.schedule();
    await sleep(160);
    ok('it stops after the configured number of idle rounds', passes === 3, String(passes));
    ok('and says so in health', kw.stats().keepWarm === 'idle (stopped)', kw.stats().keepWarm);
    ok('warm-ups are counted', kw.stats().warmups === 3, String(kw.stats().warmups));
    kw.notice();
    await sleep(60);
    ok('real traffic revives it', passes > 3, String(passes));
    ok('and health stops reporting idle', kw.stats().keepWarm === '15ms', kw.stats().keepWarm);
    kw.stop();

    let busyPasses = 0;
    const busyKw = createKeepWarm({
      intervalMs: 15, rounds: 9, ready: () => true, busy: () => true,
      warm: async () => { busyPasses++; }
    });
    busyKw.schedule();
    await sleep(80);
    ok('it never warms while real work is in flight', busyPasses === 0, String(busyPasses));
    busyKw.stop();

    const off = createKeepWarm({ intervalMs: 0, ready: () => true, warm: async () => {} });
    off.schedule();
    ok('an interval of 0 disables it', off.stats().keepWarm === 'off');
  }

  console.log('\n== the pipeline, driven with a fake model ==');
  {
    const noop = { notice() {}, schedule() {}, stop() {}, stats: () => ({}) };

    // The real decision path: buildPrompt -> infer -> normalize.
    const model = fakeModel();
    const p = createPipeline({ model, scheduler: createScheduler({ maxQueue: 1 }), keepwarm: noop });
    const d = await p.decide(snap(), { arrivedAt: Date.now() });
    ok('a served request reports the model engine', d.engine === 'laya', d.engine);
    ok('the model name comes from the answer, not a constant', d.model === 'fake-laya', String(d.model));
    ok('the move is read back', d.move === 'a', String(d.move));
    ok('prompt cost is reported from usage', d.promptTokens === 123, String(d.promptTokens));
    ok('the context-limited figure is reported too', typeof d.promptLargest === 'number');
    ok('the queue wait is reported separately from inference', typeof d.queuedMs === 'number');
    ok('health learns the model id', model.facts.modelName === 'fake-laya');

    // Not ready -> deterministic rules, and it says which.
    const loading = createPipeline({ model: fakeModel({ state: 'loading' }), scheduler: createScheduler({}), keepwarm: noop });
    const dl = await loading.decide(snap(), {});
    ok('while loading it answers from the rules', dl.engine === 'fallback', dl.engine);
    ok('and says the model is still loading', dl.reason === 'model still loading', String(dl.reason));

    const down = createPipeline({ model: fakeModel({ state: 'fallback', reason: 'model unavailable: nope' }), scheduler: createScheduler({}), keepwarm: noop });
    const dd = await down.decide(snap(), {});
    ok('an unavailable model passes its reason through', dd.reason === 'model unavailable: nope', String(dd.reason));

    // Saturated -> rules, rather than a queue of answers that arrive too late.
    const slowModel = fakeModel({ delayMs: 60 });
    const sched = createScheduler({ maxQueue: 1 });
    const busy = createPipeline({ model: slowModel, scheduler: sched, keepwarm: noop });
    const inflight = busy.decide(snap(), { arrivedAt: Date.now() });
    const shed = await busy.decide(snap(), { arrivedAt: Date.now() });
    ok('a shed request still returns a usable decision', shed.move === 'a' && shed.engine === 'fallback', JSON.stringify({ m: shed.move, e: shed.engine }));
    ok('and explains that the model was busy', /model busy/.test(shed.reason || ''), String(shed.reason));
    await inflight;

    // A departed caller must not be answered from the model's time.
    const gone = createPipeline({ model: fakeModel(), scheduler: createScheduler({ maxQueue: 1 }), keepwarm: noop });
    const dg = await gone.decide(snap(), { isAlive: () => false, arrivedAt: Date.now() });
    ok('an abandoned request falls back', dg.engine === 'fallback');
    ok('and reports that the caller went away', /went away/.test(dg.reason || ''), String(dg.reason));

    // An inference failure is a fallback, not a 500.
    const broken = createPipeline({ model: fakeModel({ throwOn: 'onnx exploded' }), scheduler: createScheduler({}), keepwarm: noop });
    const db = await broken.decide(snap(), { arrivedAt: Date.now() });
    ok('an inference failure degrades to the rules', db.engine === 'fallback');
    ok('and names the failure without leaking a stack', /inference failed: onnx exploded/.test(db.reason || ''), String(db.reason));

    // Keep-warm is told about real traffic, but not about a shed request.
    let noticed = 0;
    const counting = { notice() { noticed++; }, schedule() {}, stop() {}, stats: () => ({}) };
    const sched2 = createScheduler({ maxQueue: 1 });
    const slow2 = fakeModel({ delayMs: 60 });
    const pw = createPipeline({ model: slow2, scheduler: sched2, keepwarm: counting });
    const first = pw.decide(snap(), { arrivedAt: Date.now() });
    await pw.decide(snap(), { arrivedAt: Date.now() });   // shed
    await first;
    ok('an admitted request counts as traffic', noticed === 1, String(noticed));
    ok('a shed request does not', noticed === 1, String(noticed));
  }

  console.log('\n== static files stay inside the demo ==');
  {
    const serve = createStaticServer(path.join(__dirname, '..'));
    function resStub() {
      return {
        code: 0, headers: {}, body: null, ended: false,
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        writeHead(c, h) { this.code = c; Object.assign(this.headers, h || {}); },
        end(b) { this.body = b; this.ended = true; }
      };
    }
    let r = resStub();
    await serve(r, '/game.js');
    ok('a real file is served', r.code === 200 && r.body && r.body.length > 0, String(r.code));
    ok('with a javascript content type', /javascript/.test(r.headers['content-type'] || ''), r.headers['content-type']);

    r = resStub();
    await serve(r, '/');
    ok('the root serves index.html', r.code === 200 && /text\/html/.test(r.headers['content-type'] || ''));

    r = resStub();
    await serve(r, '/bot/board.js');
    ok('a subdirectory is served', r.code === 200, String(r.code));

    r = resStub();
    await serve(r, '/../../package.json');
    ok('a traversal is refused or contained', r.code === 403 || r.code === 404 ||
       (r.code === 200 && !/\"name\": \"laya-js\"/.test(String(r.body))), String(r.code));

    r = resStub();
    await serve(r, '/nope.js');
    ok('a missing file is a 404', r.code === 404, String(r.code));
  }

  console.log('\n== the body reader is capped ==');
  {
    async function* chunks(n, size) { for (let i = 0; i < n; i++) yield Buffer.alloc(size, 65); }
    let threw = null;
    try { await readBody(chunks(4, 100), 1000); } catch (e) { threw = e; }
    ok('a body inside the cap is read', threw === null, threw && threw.message);
    threw = null;
    try { await readBody(chunks(40, 100), 1000); } catch (e) { threw = e; }
    ok('a body over the cap is refused', threw !== null && /too large/.test(threw.message), String(threw));
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
