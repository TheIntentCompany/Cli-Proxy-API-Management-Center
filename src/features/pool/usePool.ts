import { useCallback, useEffect, useRef, useState } from 'react';
import { poolApi, type PoolState } from '@/services/api/usage';

const POLL_MS = 60_000;

/**
 * Account limit readings from the usage collector, which reads every account every few
 * minutes on its own. The page re-reads the collector once a minute while visible; it
 * never asks the providers itself. A failed read keeps the last good state on screen.
 */
export function usePool(range?: { from: number; to: number }) {
  const [state, setState] = useState<PoolState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const requestRef = useRef(0);
  const key = range ? `${range.from}:${range.to}` : 'latest';

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    try {
      const [from, to] = key === 'latest' ? [] : key.split(':').map(Number);
      const next = await poolApi.read(from !== undefined ? { from, to } : undefined);
      if (id !== requestRef.current) return;
      setState(next);
      setError(null);
      setLoadedAt(Date.now());
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [key]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { state, error, loadedAt, reload: load };
}
