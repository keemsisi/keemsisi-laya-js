import type { Answer, Questions, State, Usage } from './types.js';

/**
 * The wire protocol between a Laya client and a Laya endpoint.
 *
 * Two request shapes on purpose. Ad-hoc sends the questions from the caller,
 * which is convenient in development; presets send only a name, so a browser
 * cannot make the model answer arbitrary questions. Servers should disable
 * ad-hoc in production.
 */

export interface AdHocRequest {
  state: State;
  questions: Questions;
  preset?: never;
}

export interface PresetRequest {
  state: State;
  preset: string;
  questions?: never;
}

export type DecideRequest = AdHocRequest | PresetRequest;

export interface DecideOk {
  ok: true;
  engine: 'laya';
  model: string;
  answers: Record<string, Answer>;
  usage?: Usage;
  /** Inference time on the server, milliseconds. */
  ms: number;
  /**
   * Estimated tokens of the largest single question - the figure the context
   * window constrains, since the state is encoded once per question.
   */
  tokens?: number;
  /** Estimated sum across the batch, comparable to `usage.input_tokens`. */
  totalTokens?: number;
  trimmed?: string[];
}

export type DecideErrorCode =
  | 'unavailable'   // the model is not loaded (missing, still loading, failed)
  | 'bad_request'   // malformed state/questions, or an unknown preset
  | 'forbidden'     // ad-hoc questions sent to a preset-only endpoint
  | 'too_large'     // prompt exceeds the context window even after trimming
  | 'timeout'       // the request did not finish in time
  | 'aborted'       // the caller cancelled it (unmount, superseded request)
  | 'unreachable'   // the endpoint could not be contacted at all
  | 'internal';

export interface DecideError {
  ok: false;
  engine: 'unavailable';
  code: DecideErrorCode;
  error: string;
  ms: number;
}

export type DecideResponse = DecideOk | DecideError;

export interface HealthResponse {
  engine: 'laya' | 'loading' | 'unavailable';
  /** The model id from its most recent answer. Null until it has answered. */
  model: string | null;
  /** What was configured: a local dir, a pinned repo revision, or "injected". */
  modelSource: string | null;
  /** The checkpoint's context window, when known. */
  contextTokens: number | null;
  /** Why the engine is not ready, when it isn't. */
  reason: string | null;
  presets: string[];
  allowAdHoc: boolean;
  calls: number;
  avgMs: number;
}

export const DEFAULT_PATHS = { decide: '/laya/decide', health: '/laya/health' } as const;
