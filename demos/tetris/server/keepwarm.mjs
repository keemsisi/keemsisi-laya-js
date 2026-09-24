/* ------------------------------------------------------------------ *
 * keepwarm.mjs - keeping the weights resident.
 *
 * Every forward pass touches all 400M parameters, so when the model
 * sits idle the OS compresses or evicts those pages and the next call
 * pays to fault them back in. Measured on this machine: ~730ms warm,
 * ~2200ms after sixty seconds of idling. A tiny periodic pass keeps
 * them hot.
 *
 * It stops itself after a few idle rounds so an unused server does not
 * burn a core forever; the next real request starts it again.
 *
 * One reason to change: residency strategy. What a warming pass *is*
 * gets injected, so this module knows nothing about Laya or the queue.
 * ------------------------------------------------------------------ */

export function createKeepWarm(options) {
  const opt = options || {};
  const intervalMs = Number.isFinite(opt.intervalMs) ? opt.intervalMs : 20000;
  const rounds = Number.isFinite(opt.rounds) ? opt.rounds : 9;
  const ready = opt.ready || function () { return false; };
  const busy = opt.busy || function () { return false; };
  const warm = opt.warm;                      // injected: performs one cheap pass
  const now = opt.now || Date.now;

  let timer = null;
  let streak = 0;
  let idle = false;
  const counters = { warmups: 0, lastWarmMs: 0 };

  function schedule() {
    if (!intervalMs || !ready()) return;
    clearTimeout(timer);
    timer = setTimeout(tick, intervalMs);
    // Never hold the process open just to warm a model nobody is using.
    if (timer && timer.unref) timer.unref();
  }

  async function tick() {
    if (!ready()) return;
    if (busy()) { schedule(); return; }        // real work is keeping it hot
    if (streak >= rounds) { idle = true; return; }   // nobody is playing; go quiet
    streak++;
    const t = now();
    try {
      await warm();
      counters.warmups++;
      counters.lastWarmMs = now() - t;
    } catch { /* a failed warm-up is not worth reporting */ }
    schedule();
  }

  /** Real traffic arrived: it warms the model better than we can, and it
   *  means someone is playing, so come back out of the idle state. */
  function notice() {
    streak = 0;
    idle = false;
    schedule();
  }

  function stop() { clearTimeout(timer); timer = null; }

  function stats() {
    return {
      warmups: counters.warmups,
      lastWarmMs: counters.lastWarmMs,
      keepWarm: intervalMs ? (idle ? 'idle (stopped)' : intervalMs + 'ms') : 'off'
    };
  }

  return { schedule, notice, stop, stats };
}
