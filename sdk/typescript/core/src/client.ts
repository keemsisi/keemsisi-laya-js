import { DEFAULT_PATHS } from './protocol.js';
import type { DecideError, DecideRequest, DecideResponse, HealthResponse } from './protocol.js';
import type { Questions, State } from './types.js';

/**
 * A fetch client for a Laya endpoint.
 *
 * It never throws and never rejects. A decision model is an input to a
 * product decision, so the caller always needs a value to branch on - not a
 * try/catch. Failures come back as `{ ok: false, code }`.
 */

export interface ClientOptions {
  /** Base URL, or a path on the current origin. Default: same origin. */
  endpoint?: string;
  decidePath?: string;
  healthPath?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Injectable for tests or a non-global fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface AskOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LayaClient {
  readonly endpoint: string;
  /** Last known engine state, updated by every call. */
  engine: 'laya' | 'loading' | 'unavailable' | 'unknown';
  reason: string | null;
  inFlight: number;
  health(opts?: AskOptions): Promise<HealthResponse | null>;
  decide(request: DecideRequest, opts?: AskOptions): Promise<DecideResponse>;
  /** Sugar for the ad-hoc shape. */
  ask(state: State, questions: Questions, opts?: AskOptions): Promise<DecideResponse>;
  /** Sugar for the preset shape. */
  askPreset(state: State, preset: string, opts?: AskOptions): Promise<DecideResponse>;
}

function joinUrl(base: string, path: string): string {
  if (!base) return path;
  return base.replace(/\/+$/, '') + path;
}

function fail(code: DecideError['code'], error: string, ms: number): DecideError {
  return { ok: false, engine: 'unavailable', code, error, ms };
}

/** Links an external signal and a timeout without leaking either. */
function linkSignals(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
    timedOut: () => controller.signal.reason instanceof DOMException && controller.signal.reason.name === 'TimeoutError'
  };
}

export function createClient(options: ClientOptions = {}): LayaClient {
  const endpoint = options.endpoint ?? '';
  const decidePath = options.decidePath ?? DEFAULT_PATHS.decide;
  const healthPath = options.healthPath ?? DEFAULT_PATHS.health;
  const defaultTimeout = options.timeoutMs ?? 10_000;
  const doFetch = options.fetch ?? globalThis.fetch;

  const client: LayaClient = {
    endpoint,
    engine: 'unknown',
    reason: null,
    inFlight: 0,

    async health(opts = {}) {
      if (!doFetch) { client.engine = 'unavailable'; client.reason = 'no fetch available'; return null; }
      const link = linkSignals(opts.timeoutMs ?? Math.min(defaultTimeout, 5000), opts.signal);
      try {
        const res = await doFetch(joinUrl(endpoint, healthPath), {
          signal: link.signal,
          headers: options.headers
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = (await res.json()) as HealthResponse;
        client.engine = body.engine ?? 'unknown';
        client.reason = body.reason ?? null;
        return body;
      } catch (err) {
        client.engine = 'unavailable';
        client.reason = describe(err, link.timedOut());
        return null;
      } finally {
        link.done();
      }
    },

    async decide(request, opts = {}) {
      const started = Date.now();
      if (!doFetch) return fail('unreachable', 'no fetch available', 0);
      if (!request || typeof request !== 'object') return fail('bad_request', 'a request object is required', 0);
      if (!('preset' in request) && !('questions' in request)) {
        return fail('bad_request', 'provide either questions or a preset', 0);
      }
      // Already cancelled before we started: skip the round trip entirely.
      if (opts.signal?.aborted) return fail('aborted', 'cancelled before the request started', 0);

      const link = linkSignals(opts.timeoutMs ?? defaultTimeout, opts.signal);
      client.inFlight++;
      try {
        const res = await doFetch(joinUrl(endpoint, decidePath), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...options.headers },
          body: JSON.stringify(request),
          signal: link.signal
        });
        const ms = Date.now() - started;
        let body: unknown = null;
        try { body = await res.json(); } catch { /* handled below */ }

        if (!res.ok) {
          const e = body as Partial<DecideError> | null;
          const code = e?.code ?? (res.status === 503 ? 'unavailable' : res.status === 400 ? 'bad_request' : res.status === 403 ? 'forbidden' : 'internal');
          client.engine = code === 'unavailable' ? 'unavailable' : client.engine;
          client.reason = e?.error ?? 'HTTP ' + res.status;
          return fail(code, e?.error ?? 'HTTP ' + res.status, ms);
        }
        const okBody = body as DecideResponse | null;
        if (!okBody || typeof okBody !== 'object' || !('ok' in okBody)) {
          return fail('internal', 'malformed response from the endpoint', ms);
        }
        if (okBody.ok) { client.engine = 'laya'; client.reason = null; }
        return okBody;
      } catch (err) {
        const ms = Date.now() - started;
        const timedOut = link.timedOut();
        client.reason = describe(err, timedOut);
        // A cancelled request is not a failure of the model; React unmounts
        // and superseded requests land here constantly.
        if (opts.signal?.aborted) return fail('aborted', 'cancelled by the caller', ms);
        if (timedOut) return fail('timeout', `no answer within ${opts.timeoutMs ?? defaultTimeout}ms`, ms);
        client.engine = 'unavailable';
        return fail('unreachable', client.reason, ms);
      } finally {
        client.inFlight--;
        link.done();
      }
    },

    ask(state, questions, opts) {
      return client.decide({ state, questions }, opts);
    },

    askPreset(state, preset, opts) {
      return client.decide({ state, preset }, opts);
    }
  };

  return client;
}

function describe(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timed out';
  if (err instanceof Error) return err.name === 'AbortError' ? 'aborted' : err.message;
  return String(err);
}
