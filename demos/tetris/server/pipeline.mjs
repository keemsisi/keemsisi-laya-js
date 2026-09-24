/* ------------------------------------------------------------------ *
 * pipeline.mjs - a board snapshot in, a decision out.
 *
 * The decision flow, and only the flow: when to ask the model, when to
 * answer from the deterministic rules instead, and what to report about
 * the prompt afterwards. One reason to change: that flow.
 *
 * Every collaborator is injected, so a test can drive the real path with
 * a fake model instead of reimplementing it. Board-to-prompt translation
 * lives in decide.mjs; hosting, scheduling and residency each live in
 * their own module.
 * ------------------------------------------------------------------ */

import { buildPrompt, normalize, fallbackDecision } from './decide.mjs';

export function createPipeline(deps) {
  const model = deps.model;
  const scheduler = deps.scheduler;
  const keepwarm = deps.keepwarm;

  function fallback(snap, reason, extra) {
    return fallbackDecision(snap, Object.assign({ engine: 'fallback', reason: reason }, extra || {}));
  }

  async function decide(snap, context) {
    const ctx = context || {};

    if (!model.ready()) {
      return fallback(snap, model.facts.state === 'loading'
        ? 'model still loading'
        : model.facts.reason);
    }

    const prompt = buildPrompt(snap);
    const result = await scheduler.run(
      function () { return model.infer(prompt.state, prompt.questions); },
      {
        isAlive: ctx.isAlive,
        arrivedAt: ctx.arrivedAt,
        // Real traffic is the best warm-up, and it means someone is playing.
        // Fired on admission so a shed request does not count as traffic.
        onAdmitted: function () { keepwarm.notice(); }
      }
    );

    if (!result.ok) {
      if (result.reason === 'saturated') {
        // Already behind: answer now from the rules rather than joining a
        // queue whose answers will all arrive too late to be used.
        return fallback(snap, 'model busy (' + result.queued +
                              ' already waiting); answered from the rules instead');
      }
      if (result.reason === 'abandoned') {
        return fallback(snap, result.message);
      }
      const err = result.error;
      return fallback(snap, 'inference failed: ' + (err && err.message ? err.message : String(err)),
                      { ms: result.ms });
    }

    const raw = result.value;
    model.observeModelName(raw);
    const d = normalize(raw, snap, { engine: 'laya', ms: result.ms, model: raw && raw.model });
    d.queuedMs = result.queuedMs;
    // What the model actually charged, falling back to the estimate when it
    // reports nothing. `promptLargest` is the context-limited figure.
    d.promptTokens = (raw && raw.usage && raw.usage.input_tokens) || prompt.estimatedTotal;
    d.promptLargest = prompt.tokens;
    d.promptEstimatedTotal = prompt.estimatedTotal;
    d.promptTrimmed = prompt.trimmed;
    return d;
  }

  return { decide };
}
