/* ------------------------------------------------------------------ *
 * scheduler.mjs - one forward pass at a time, and what to do when
 * that is not fast enough.
 *
 * ONNX holds a single session, so passes are serialised; serialising
 * also keeps memory predictable. The interesting part is the refusals:
 * a game asks once per piece, so a backlog means the model is already
 * behind and queueing more only makes every answer later than the last.
 *
 * One reason to change: concurrency policy. Policy outcomes come back
 * as a result to branch on rather than as exceptions - a saturated
 * queue and a departed caller are normal operating states, not faults.
 * ------------------------------------------------------------------ */

export function createScheduler(options) {
  const opt = options || {};
  const maxQueue = Number.isFinite(opt.maxQueue) ? opt.maxQueue : 1;
  const now = opt.now || Date.now;

  let chain = Promise.resolve();
  let queued = 0;
  const counters = { calls: 0, totalMs: 0, totalQueuedMs: 0, shed: 0, abandoned: 0 };

  // `chain.then(fn, fn)` runs the next pass whether the previous one settled
  // or threw; the catch keeps a rejection from poisoning the chain.
  function serialise(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(function () {});
    return run;
  }

  function saturated() { return queued >= maxQueue; }
  function busy() { return queued > 0; }

  /**
   * `arrivedAt` is stamped when the request landed, not when this runs. A
   * forward pass saturates the CPU and starves the event loop, so a request
   * can sit unparsed at the socket for seconds - invisible to any counter
   * kept inside this function. Measuring from arrival is the only figure
   * that reflects what the caller actually experienced.
   */
  async function run(fn, context) {
    const ctx = context || {};
    if (saturated()) {
      counters.shed++;
      return { ok: false, reason: 'saturated', queued: queued };
    }

    // Admitted: past the saturation check and about to take the lock. The
    // caller uses this to count real traffic, which a shed request is not.
    if (ctx.onAdmitted) ctx.onAdmitted();

    const queuedAt = ctx.arrivedAt || now();
    let queuedMs = 0;
    queued++;
    try {
      const value = await serialise(function () {
        queuedMs = now() - queuedAt;
        // The caller may have given up while we waited for the lock. Running
        // the pass anyway would hold the model hostage for the next caller.
        if (ctx.isAlive && !ctx.isAlive()) {
          const e = new Error('caller went away after ' + queuedMs + 'ms in the queue');
          e.abandoned = true;
          throw e;
        }
        return fn();
      });
      // Inference only: the queue wait is reported separately so a backlog
      // cannot masquerade as a slow model.
      const ms = now() - queuedAt - queuedMs;
      counters.calls++;
      counters.totalMs += ms;
      counters.totalQueuedMs += queuedMs;
      return { ok: true, value: value, ms: ms, queuedMs: queuedMs };
    } catch (err) {
      if (err && err.abandoned) {
        counters.abandoned++;
        return { ok: false, reason: 'abandoned', queuedMs: queuedMs, message: err.message };
      }
      return { ok: false, reason: 'failed', error: err, ms: now() - queuedAt };
    } finally {
      queued--;
    }
  }

  function stats() {
    const c = counters.calls;
    return {
      calls: c,
      avgMs: c ? Math.round(counters.totalMs / c) : 0,
      avgQueuedMs: c ? Math.round(counters.totalQueuedMs / c) : 0,
      queued: queued,
      maxQueue: maxQueue,
      shed: counters.shed,
      abandoned: counters.abandoned
    };
  }

  return { run, saturated, busy, stats };
}
