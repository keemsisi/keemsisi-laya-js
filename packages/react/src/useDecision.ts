import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { gate, readAll, readAnswersByType } from '@laya-js/core';
import type {
  Answer, DecideError, DecideOk, DecideRequest, Gate, Questions, Reading, ReadingsFor,
  ScoreQuestion, State
} from '@laya-js/core';
import { useLaya } from './context.js';

export type DecisionInput<Q extends Questions = Questions> =
  | { state: State; questions: Q; preset?: never }
  | { state: State; preset: string; questions?: never };

/** Score questions have no gate, so they are dropped from the gate map. */
export type GatesFor<Q extends Questions> = {
  [K in keyof Q as Q[K] extends ScoreQuestion ? never : K]: Gate;
};

export interface UseDecisionOptions<Q extends Questions = Questions> {
  /**
   * The question shape, for a preset request.
   *
   * Never sent to the server - the preset is still what the server uses.
   * It types the readings and supplies the offered options and rubric
   * labels the answers alone cannot carry. Import it from the same module
   * the server registers as the preset.
   */
  shape?: Q;
  /** Hold off until true. Useful while the state is still being filled in. */
  enabled?: boolean;
  /** Probability floor for `gates`. Defaults to the provider's floor. */
  floor?: number;
  timeoutMs?: number;
  /**
   * Override the identity of this request. By default the input is
   * serialized, so a new object with the same contents does not re-ask.
   */
  key?: string;
  onSuccess?: (data: DecideOk) => void;
  onError?: (error: DecideError) => void;
}

export interface DecisionResult<Q extends Questions = Questions> {
  status: 'idle' | 'loading' | 'success' | 'error';
  loading: boolean;
  data: DecideOk | null;
  answers: Record<string, Answer> | null;
  /**
   * Answers parsed defensively, keyed like the questions and typed per
   * question - `readings.department.value` compiles with no `kind` check
   * when the questions were passed inline.
   */
  readings: ReadingsFor<Q> | null;
  /** Per-question confidence gate, for choice and noul questions. */
  gates: GatesFor<Q> | null;
  error: DecideError | null;
  /** Server-side inference time, milliseconds. */
  ms: number | null;
  /** Ask again, ignoring the cached result. */
  refresh: () => void;
  /** Abort the in-flight request without starting another. */
  cancel: () => void;
}

const IDLE: Omit<DecisionResult<Questions>, 'refresh' | 'cancel'> = {
  status: 'idle', loading: false, data: null, answers: null,
  readings: null, gates: null, error: null, ms: null
};

function stableKey(input: DecisionInput<Questions>): string {
  try {
    return JSON.stringify([input.state, input.questions ?? null, input.preset ?? null]);
  } catch {
    // Circular or unserializable state: fall back to asking on every change.
    return String(Math.random());
  }
}

function deriveQuestions(
  input: DecisionInput<Questions>,
  options: UseDecisionOptions<Questions>
): Questions | null {
  return input.questions ?? options.shape ?? null;
}

/**
 * Ask Laya one decision and keep it in sync with its inputs.
 *
 * Re-asks when the serialized input changes, aborts on unmount, and ignores
 * superseded responses - so a slow answer can never overwrite a newer one.
 */
export function useDecision<Q extends Questions>(
  input: { state: State; questions: Q; preset?: never },
  options?: UseDecisionOptions<Q>
): DecisionResult<Q>;
/**
 * A preset plus the question shape: the server still uses the preset, and
 * the shape types the readings and labels them. Q is inferred from it.
 */
export function useDecision<Q extends Questions>(
  input: { state: State; preset: string; questions?: never },
  options: UseDecisionOptions<Q> & { shape: Q }
): DecisionResult<Q>;
/**
 * A preset with no shape. Readings are still parsed - Laya's answers carry
 * their own type - but they are the union, with no rubric labels.
 */
export function useDecision<Q extends Questions = Questions>(
  input: { state: State; preset: string; questions?: never },
  options?: UseDecisionOptions<Q>
): DecisionResult<Q>;
export function useDecision(
  input: DecisionInput<Questions>,
  options: UseDecisionOptions<Questions> = {}
): DecisionResult<Questions> {
  const { client, floor: providerFloor } = useLaya();
  const enabled = options.enabled ?? true;
  const floor = options.floor ?? providerFloor;
  const key = options.key ?? stableKey(input);

  const [result, setResult] = useState(IDLE);

  // Latest values, read inside the effect, so the effect depends only on the
  // request identity and not on every new callback or object literal.
  const inputRef = useRef(input);
  inputRef.current = input;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [nonce, setNonce] = useState(0);

  const start = useCallback(() => {
    const id = ++requestId.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;

    setResult((prev) => ({ ...prev, status: 'loading', loading: true, error: null }));

    const current = inputRef.current;
    const opts = optionsRef.current;
    void client.decide(current as DecideRequest, {
      signal: ac.signal,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
    }).then((res) => {
      // Superseded by a newer request, or cancelled: drop it silently.
      if (requestId.current !== id) return;
      if (!res.ok && res.code === 'aborted') return;

      if (res.ok) {
        const questions = deriveQuestions(current, opts);
        // With a shape: validated against the offered options and labelled
        // from the rubric. Without one: parsed from each answer's own type,
        // so a preset request still yields readings.
        const readings = questions ? readAll(questions, res.answers) : readAnswersByType(res.answers);
        const gates = readings
          ? (Object.fromEntries(
              Object.entries(readings as Record<string, Reading>)
                .filter(([, r]) => r.kind !== 'score')
                .map(([k, r]) => [k, gate(r as never, floor)])
            ) as GatesFor<Questions>)
          : null;
        setResult({
          status: 'success', loading: false, data: res, answers: res.answers,
          readings, gates, error: null, ms: res.ms
        });
        opts.onSuccess?.(res);
      } else {
        setResult({
          status: 'error', loading: false, data: null, answers: null,
          readings: null, gates: null, error: res, ms: res.ms
        });
        opts.onError?.(res);
      }
    });
  }, [client, floor]);

  useEffect(() => {
    if (!enabled) {
      controller.current?.abort();
      requestId.current++;
      setResult(IDLE);
      return;
    }
    start();
    return () => { controller.current?.abort(); };
    // `key` is the request identity; `nonce` forces a refresh.
  }, [key, enabled, nonce, start]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const cancel = useCallback(() => {
    controller.current?.abort();
    requestId.current++;
    setResult((prev) => (prev.loading ? { ...prev, status: 'idle', loading: false } : prev));
  }, []);

  return useMemo(() => ({ ...result, refresh, cancel }), [result, refresh, cancel]);
}

export interface DecisionCallbackState<Q extends Questions = Questions> {
  loading: boolean;
  data: DecideOk | null;
  readings: ReadingsFor<Q> | null;
  error: DecideError | null;
  reset: () => void;
}

/**
 * Imperative form: decide in response to an event rather than to a render.
 * Returns the raw response so the caller can branch on it directly.
 */
export function useDecisionCallback<Q extends Questions = Questions>(
  options: Omit<UseDecisionOptions<Q>, 'enabled' | 'key'> = {}
): [(input: DecisionInput<Q>) => Promise<DecideOk | DecideError>, DecisionCallbackState<Q>] {
  const { client, floor: providerFloor } = useLaya();
  const floor = options.floor ?? providerFloor;
  const [state, setState] = useState<Omit<DecisionCallbackState<Q>, 'reset'>>({
    loading: false, data: null, readings: null, error: null
  });
  const mounted = useRef(true);
  const seq = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const decide = useCallback(async (input: DecisionInput<Q>) => {
    const id = ++seq.current;
    if (mounted.current) setState((s) => ({ ...s, loading: true, error: null }));
    const opts = optionsRef.current;
    const res = await client.decide(input as unknown as DecideRequest, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {})
    });
    // Always return the result, even after unmount; only skip the setState.
    if (mounted.current && seq.current === id) {
      if (res.ok) {
        const questions = deriveQuestions(input as DecisionInput<Questions>, opts as UseDecisionOptions<Questions>);
        setState({
          loading: false, data: res, error: null,
          readings: (questions
            ? readAll(questions, res.answers)
            : readAnswersByType(res.answers)) as unknown as ReadingsFor<Q>
        });
        opts.onSuccess?.(res);
      } else {
        setState({ loading: false, data: null, readings: null, error: res });
        opts.onError?.(res);
      }
    }
    return res;
  }, [client, floor]);

  const reset = useCallback(() => {
    seq.current++;
    if (mounted.current) setState({ loading: false, data: null, readings: null, error: null });
  }, []);

  return [decide, { ...state, reset }];
}
