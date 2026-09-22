import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createClient } from '@laya-js/core';
import type { ClientOptions, HealthResponse, LayaClient } from '@laya-js/core';

/**
 * Laya runs on ONNX Runtime under Node and its weights are ~1.7 GB, so it
 * cannot run in the browser. The provider holds a client for a Laya endpoint
 * - stand one up with @laya-js/server.
 */

export interface LayaContextValue {
  client: LayaClient;
  /** Default probability floor for `gates` in useDecision. */
  floor: number;
  engine: LayaClient['engine'];
  reason: string | null;
  health: HealthResponse | null;
  refreshHealth: () => void;
}

const LayaContext = createContext<LayaContextValue | null>(null);

export interface LayaProviderProps extends ClientOptions {
  children?: ReactNode;
  /** Supply a client directly instead of building one from the options. */
  client?: LayaClient;
  /** Default confidence floor for gating decisions. Laya's docs recommend gating. */
  floor?: number;
  /** Check the endpoint's health on mount so the UI can show engine state. */
  checkHealth?: boolean;
  /** Re-check every N ms. Off when unset. */
  healthIntervalMs?: number;
}

export function LayaProvider(props: LayaProviderProps) {
  const {
    children, client: injected, floor = 0.34, checkHealth = true, healthIntervalMs,
    endpoint, decidePath, healthPath, timeoutMs, headers, fetch: fetchImpl
  } = props;

  // A new client on every render would restart every in-flight decision.
  const client = useMemo(
    () => injected ?? createClient({ endpoint, decidePath, healthPath, timeoutMs, headers, fetch: fetchImpl }),
    [injected, endpoint, decidePath, healthPath, timeoutMs, headers, fetchImpl]
  );

  /**
   * The probe result is stored as a whole object rather than just the health
   * body: a failed probe returns null, and setting null over null is a no-op
   * that React bails out of, which would leave the engine state stale.
   */
  interface Probe { health: HealthResponse | null; engine: LayaClient['engine']; reason: string | null; checked: boolean }
  const [probe, setProbe] = useState<Probe>({ health: null, engine: client.engine, reason: client.reason, checked: false });
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!checkHealth) return;
    let cancelled = false;
    const ac = new AbortController();
    void client.health({ signal: ac.signal }).then((h) => {
      // The client records engine/reason itself, including on failure.
      if (!cancelled) setProbe({ health: h, engine: client.engine, reason: client.reason, checked: true });
    });
    return () => { cancelled = true; ac.abort(); };
  }, [client, checkHealth, tick]);

  useEffect(() => {
    if (!healthIntervalMs || !checkHealth) return;
    const id = setInterval(() => setTick((t) => t + 1), healthIntervalMs);
    return () => clearInterval(id);
  }, [healthIntervalMs, checkHealth]);

  const value = useMemo<LayaContextValue>(() => ({
    client,
    floor,
    // Reflects the last completed health probe. A decide() call can change
    // the client's own view later; call refreshHealth() to re-probe.
    engine: probe.checked ? probe.engine : client.engine,
    reason: probe.checked ? probe.reason : client.reason,
    health: probe.health,
    refreshHealth: () => setTick((t) => t + 1)
  }), [client, floor, probe]);

  return createElement(LayaContext.Provider, { value }, children);
}

export function useLaya(): LayaContextValue {
  const ctx = useContext(LayaContext);
  if (!ctx) {
    throw new Error('useLaya must be used inside a <LayaProvider>. Wrap your app, or the subtree that decides, in one.');
  }
  return ctx;
}

/** Non-throwing variant, for components that may render outside a provider. */
export function useOptionalLaya(): LayaContextValue | null {
  return useContext(LayaContext);
}
