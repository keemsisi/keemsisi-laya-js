import {
  CONTEXT_TOKENS, DEFAULT_PATHS, defaultBudget, estimateTokenBreakdown, fitToContext,
  validateQuestions, validateState
} from '@laya-js/core';
import type {
  DecideError, DecideErrorCode, DecideRequest, DecideResponse, FitOptions,
  HealthResponse, Questions, State
} from '@laya-js/core';
import { describeSource, loadReceptronLaya } from './engine.js';
import type { LayaLike, ModelSource } from './engine.js';

/** A preset is a fixed question set, or one derived from the incoming state. */
export type Preset = Questions | ((state: State) => Questions);

export interface LayaServerOptions extends ModelSource {
  /**
   * Named question sets the client may ask for. Presets keep prompt
   * construction on the server, so a browser cannot make the model answer
   * arbitrary questions.
   */
  presets?: Record<string, Preset>;
  /**
   * Allow clients to send their own questions. Off by default: it is
   * convenient in development and an open prompt endpoint in production.
   */
  allowAdHoc?: boolean;
  /** Which checkpoint's context window to budget against. */
  context?: keyof typeof CONTEXT_TOKENS;
  /** Token budget. Defaults to 85% of the chosen context window. */
  budget?: number;
  /** How to trim an oversized prompt. Without this, oversized is an error. */
  fit?: FitOptions;
  /** Load the model at construction instead of on the first decision. */
  eager?: boolean;
  /** Inject a model. Used by tests, or to share one instance across servers. */
  load?: () => Promise<LayaLike>;
  /** Reject rather than queue when this many decisions are already waiting. */
  maxQueue?: number;
  /** Largest accepted request body, in bytes. */
  maxBodyBytes?: number;
  /** Access-Control-Allow-Origin value. Omitted entirely when unset. */
  cors?: string;
  logger?: (line: string) => void;
}

export interface LayaServer {
  health(): HealthResponse;
  decide(request: DecideRequest): Promise<DecideResponse>;
  /** Handler for node:http and Express. */
  handler(req: NodeRequest, res: NodeResponse): void;
  /** Handler for Request/Response runtimes: Next.js App Router, Hono, Bun. */
  fetchHandler(request: Request): Promise<Response>;
  /** Force the model to load now; resolves even if it fails. */
  warmup(): Promise<HealthResponse>;
  close(): Promise<void>;
}

export interface NodeRequest {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, unknown>;
  on(event: string, cb: (chunk?: unknown) => void): unknown;
  setEncoding?(enc: string): unknown;
}

export interface NodeResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

const HTTP_FOR_CODE: Record<DecideErrorCode, number> = {
  unavailable: 503,
  bad_request: 400,
  forbidden: 403,
  too_large: 413,
  timeout: 504,
  aborted: 499,
  unreachable: 502,
  internal: 500
};

function err(code: DecideErrorCode, message: string, ms = 0): DecideError {
  return { ok: false, engine: 'unavailable', code, error: message, ms };
}

export function createLayaServer(options: LayaServerOptions = {}): LayaServer {
  const presets = options.presets ?? {};
  const allowAdHoc = options.allowAdHoc ?? false;
  const context = options.context ?? 'english';
  const budget = options.budget ?? defaultBudget(context);
  const maxQueue = options.maxQueue ?? 16;
  const maxBody = options.maxBodyBytes ?? 256 * 1024;
  const log = options.logger ?? (() => {});

  let model: LayaLike | null = null;
  let loading: Promise<LayaLike> | null = null;
  let reason: string | null = null;
  let calls = 0;
  let totalMs = 0;
  /** Learned from inference rather than assumed: an injected model is not Laya. */
  let modelName: string | null = null;
  let queued = 0;
  let chain: Promise<unknown> = Promise.resolve();

  if (!options.modelDir && !options.load && !options.revision) {
    log('[laya] revision is unpinned ("main"); the weight download is size-checked but not checksummed. ' +
        'Pass revision: "<commit sha>" to bind to a published commit.');
  }

  function engineState(): HealthResponse['engine'] {
    if (model) return 'laya';
    if (loading) return 'loading';
    return 'unavailable';
  }

  function ensureModel(): Promise<LayaLike> {
    if (model) return Promise.resolve(model);
    if (!loading) {
      const loader = options.load ?? (() => loadReceptronLaya(options));
      loading = loader()
        .then((m) => { model = m; reason = null; log('[laya] model ready'); return m; })
        .catch((e: unknown) => {
          reason = e instanceof Error ? e.message : String(e);
          loading = null;
          log('[laya] load failed: ' + reason);
          throw e;
        });
    }
    return loading;
  }

  /** One forward pass at a time: the model holds a single ONNX session. */
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  function resolveQuestions(request: DecideRequest): { questions?: Questions; error?: DecideError } {
    if ('preset' in request && request.preset !== undefined) {
      if (typeof request.preset !== 'string') return { error: err('bad_request', 'preset must be a string') };
      const preset = presets[request.preset];
      if (!preset) {
        const known = Object.keys(presets);
        return {
          error: err('bad_request',
            `unknown preset "${request.preset}"` + (known.length ? `; known presets: ${known.join(', ')}` : '; no presets are registered'))
        };
      }
      try {
        const questions = typeof preset === 'function' ? preset(request.state) : preset;
        const problems = validateQuestions(questions);
        if (problems.length) return { error: err('internal', 'preset produced invalid questions: ' + problems[0]) };
        return { questions };
      } catch (e) {
        return { error: err('internal', 'preset threw: ' + (e instanceof Error ? e.message : String(e))) };
      }
    }

    if (!allowAdHoc) {
      return {
        error: err('forbidden',
          'ad-hoc questions are disabled; use a registered preset' +
          (Object.keys(presets).length ? ` (${Object.keys(presets).join(', ')})` : '') +
          ' or construct the server with allowAdHoc: true')
      };
    }
    const problems = validateQuestions((request as { questions?: unknown }).questions);
    if (problems.length) return { error: err('bad_request', problems.join('; ')) };
    return { questions: (request as { questions: Questions }).questions };
  }

  async function decide(request: DecideRequest): Promise<DecideResponse> {
    const started = Date.now();
    if (!request || typeof request !== 'object') return err('bad_request', 'a request body is required');

    const stateProblems = validateState((request as { state?: unknown }).state);
    if (stateProblems.length) return err('bad_request', stateProblems.join('; '));

    const resolved = resolveQuestions(request);
    if (resolved.error) return resolved.error;
    const questions = resolved.questions!;
    const state = request.state;

    // Size the prompt before spending an inference on it.
    //
    // The state is encoded once per question, so the context window limits
    // the LARGEST question, not the sum across the batch. Budgeting against
    // the total would reject prompts that fit perfectly well.
    let finalState: State = state;
    let finalQuestions: Questions = questions;
    let est = estimateTokenBreakdown(state, questions);
    let tokens = est.largest;
    let totalTokens = est.total;
    let trimmed: string[] = [];
    if (tokens > budget) {
      if (!options.fit) {
        return err('too_large',
          `the largest question is about ${tokens} tokens, over the ${budget}-token budget for the ` +
          `${context} checkpoint (${CONTEXT_TOKENS[context]}-token context; the batch totals about ` +
          `${totalTokens}). Shorten it, or configure fit to trim automatically.`);
      }
      const fitted = fitToContext(state, questions, { budget, ...options.fit });
      if (fitted.overBudget) {
        return err('too_large',
          `the largest question is about ${fitted.tokens} tokens after trimming, still over the ${budget}-token budget`);
      }
      finalState = fitted.state;
      finalQuestions = fitted.questions;
      tokens = fitted.tokens;
      totalTokens = fitted.total;
      trimmed = fitted.trimmed;
    }

    let live: LayaLike;
    try {
      live = await ensureModel();
    } catch {
      return err('unavailable', reason ?? 'the model is not available');
    }

    // Checked immediately before the increment, with no await in between:
    // with an await here every concurrent caller reads the same stale zero
    // and the limit never engages.
    if (queued >= maxQueue) {
      return err('unavailable', `too many decisions in flight (${queued}); try again shortly`);
    }
    queued++;
    try {
      const raw = await serialize(() => live.systemOne(finalState, finalQuestions));
      const ms = Date.now() - started;
      calls++;
      totalMs += ms;
      if (raw && typeof raw === 'object' && typeof raw.model === 'string') modelName = raw.model;
      if (!raw || typeof raw !== 'object' || !raw.answers) {
        return err('internal', 'the model returned no answers', ms);
      }
      return {
        ok: true,
        engine: 'laya',
        model: raw.model ?? 'unknown',
        answers: raw.answers as DecideResponse extends { answers: infer A } ? A : never,
        ...(raw.usage ? { usage: raw.usage } : {}),
        ms,
        tokens,                            // largest question: the context-limited figure
        totalTokens,                       // sum across the batch, near usage.input_tokens
        ...(trimmed.length ? { trimmed } : {})
      } as DecideResponse;
    } catch (e) {
      return err('internal', 'inference failed: ' + (e instanceof Error ? e.message : String(e)), Date.now() - started);
    } finally {
      queued--;
    }
  }

  function health(): HealthResponse {
    return {
      engine: engineState(),
      // Whatever the loaded model reported on its last answer - null until it
      // has answered once. Never a hardcoded name that an injected stub would
      // inherit. `modelSource` says what was configured, and is known up front.
      model: modelName,
      modelSource: describeSource(options, Boolean(options.load)),
      contextTokens: model?.config?.max_len ?? (model ? CONTEXT_TOKENS[context] : null),
      reason,
      presets: Object.keys(presets),
      allowAdHoc,
      calls,
      avgMs: calls ? Math.round(totalMs / calls) : 0
    };
  }

  function applyCors(set: (k: string, v: string) => void) {
    if (!options.cors) return;
    set('access-control-allow-origin', options.cors);
    set('access-control-allow-headers', 'content-type');
    set('access-control-allow-methods', 'POST, GET, OPTIONS');
  }

  const decidePath = DEFAULT_PATHS.decide;
  const healthPath = DEFAULT_PATHS.health;

  function pathOf(url: string | undefined): string {
    if (!url) return '/';
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  function handler(req: NodeRequest, res: NodeResponse): void {
    const path = pathOf(req.url);
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      applyCors((k, v) => res.setHeader(k, v));
      res.end(text);
    };

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      applyCors((k, v) => res.setHeader(k, v));
      res.end();
      return;
    }
    if (path.endsWith(healthPath) || path === '/health') return send(200, health());
    if (!path.endsWith(decidePath) && path !== '/decide') return send(404, err('bad_request', 'not found'));
    if (req.method !== 'POST') return send(405, err('bad_request', 'POST only'));

    let size = 0;
    const chunks: string[] = [];
    let aborted = false;
    req.setEncoding?.('utf8');
    req.on('data', (chunk) => {
      if (aborted) return;
      const s = String(chunk);
      size += s.length;
      if (size > maxBody) { aborted = true; send(413, err('too_large', 'request body too large')); return; }
      chunks.push(s);
    });
    req.on('error', () => { if (!aborted) { aborted = true; send(400, err('bad_request', 'request stream error')); } });
    req.on('end', () => {
      if (aborted) return;
      let body: DecideRequest;
      try { body = JSON.parse(chunks.join('')) as DecideRequest; }
      catch { return send(400, err('bad_request', 'body must be valid JSON')); }
      decide(body).then(
        (r) => send(r.ok ? 200 : HTTP_FOR_CODE[r.code], r),
        (e: unknown) => send(500, err('internal', e instanceof Error ? e.message : String(e)))
      );
    });
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    applyCors((k, v) => headers.set(k, v));
    const path = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (path.endsWith(healthPath) || path === '/health') {
      return new Response(JSON.stringify(health()), { status: 200, headers });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify(err('bad_request', 'POST only')), { status: 405, headers });
    }
    const text = await request.text();
    if (text.length > maxBody) {
      return new Response(JSON.stringify(err('too_large', 'request body too large')), { status: 413, headers });
    }
    let body: DecideRequest;
    try { body = JSON.parse(text) as DecideRequest; }
    catch {
      return new Response(JSON.stringify(err('bad_request', 'body must be valid JSON')), { status: 400, headers });
    }
    const r = await decide(body);
    return new Response(JSON.stringify(r), { status: r.ok ? 200 : HTTP_FOR_CODE[r.code], headers });
  }

  async function warmup(): Promise<HealthResponse> {
    try { await ensureModel(); } catch { /* reason is recorded */ }
    return health();
  }

  if (options.eager) void warmup();

  return { health, decide, handler, fetchHandler, warmup, close: async () => {
    try { await model?.close?.(); } finally { model = null; loading = null; modelName = null; }
  } };
}
