import { useCallback, useEffect, useState } from 'react';
import { codexLbApi, type CodexLbStatus } from '@/services/api/codexLb';
import { useAuthStore } from '@/stores';
import { useInterval } from './useInterval';

const POLL_MS = 60_000;
/** Reuse an answer across page switches; the endpoint itself caches for 15 seconds. */
const FRESH_MS = 20_000;

interface CacheEntry {
  scope: string;
  at: number;
  value: CodexLbStatus | null;
}

let cache: CacheEntry | null = null;
let inFlight: { scope: string; promise: Promise<CodexLbStatus | null> } | null = null;

const load = (scope: string, force: boolean): Promise<CodexLbStatus | null> => {
  if (!force && cache && cache.scope === scope && Date.now() - cache.at < FRESH_MS) {
    return Promise.resolve(cache.value);
  }
  if (inFlight && inFlight.scope === scope) return inFlight.promise;
  const promise = codexLbApi
    .getStatus()
    .catch(() => null)
    .then((value) => {
      // A newer connection may have replaced this one while the request ran.
      if (inFlight?.promise === promise) inFlight = null;
      if (useAuthStore.getState().apiBase !== scope) return value;
      // A failed refresh keeps the last good answer; each window carries its own
      // recorded time, so an old answer still shows how old it is.
      const kept = value ?? (cache?.scope === scope ? cache.value : null);
      cache = { scope, at: Date.now(), value: kept };
      return kept;
    });
  inFlight = { scope, promise };
  return promise;
};

/**
 * Status of the codex-lb accounts behind CLIProxyAPI's Codex API keys, or null when
 * the deployment has no status service. Shared by Overview, Accounts and Limits.
 */
export function useCodexLbStatus() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const scope = useAuthStore((state) => state.apiBase);
  const [state, setState] = useState<{ scope: string; value: CodexLbStatus | null }>(() => ({
    scope,
    value: cache && cache.scope === scope ? cache.value : null,
  }));

  const refresh = useCallback(
    async (force = false) => {
      if (!connected || !scope) return;
      const value = await load(scope, force);
      if (useAuthStore.getState().apiBase !== scope) return;
      setState((current) =>
        current.scope === scope && current.value === value ? current : { scope, value }
      );
    },
    [connected, scope]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useInterval(
    () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh(true);
    },
    connected ? POLL_MS : null
  );

  return {
    status: connected && state.scope === scope ? state.value : null,
    refresh,
  };
}
