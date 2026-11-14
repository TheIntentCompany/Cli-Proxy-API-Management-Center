import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { apiKeysApi } from '@/services/api/apiKeys';
import { usageApi, type UsageFilters, type UsageSummary } from '@/services/api/usage';
import { apiKeyNameFingerprint, readApiKeyNames } from '@/features/config/apiKeyNames';
import { useAuthStore } from '@/stores';

const POLL_MS = 30_000;

/**
 * Reads a usage summary and re-reads it every 30 s while the page is open. A failed read
 * keeps the last good summary on screen and reports the error beside it.
 */
export function useUsageSummary(filters: UsageFilters | null, bucket: 'hour' | 'day') {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const key = filters ? JSON.stringify([filters, bucket]) : null;

  const load = useCallback(async () => {
    if (!key) return;
    const [current, currentBucket] = JSON.parse(key) as [UsageFilters, 'hour' | 'day'];
    const id = ++requestRef.current;
    setLoading(true);
    try {
      const next = await usageApi.summary(current, currentBucket);
      if (id !== requestRef.current) return;
      setSummary(next);
      setError(null);
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { summary, error, loading, reload: load };
}

/** The collector's key id: first 16 hex of sha256 of the raw client key. */
const collectorKeyId = (apiKey: string) =>
  bytesToHex(sha256(new TextEncoder().encode(apiKey))).slice(0, 16);

/**
 * Names for client keys, keyed by the collector's key id. Names live in this browser
 * (set on the Config page); raw keys are hashed here and never leave the panel.
 */
export function useClientKeyNames(): Record<string, string> {
  const apiBase = useAuthStore((state) => state.apiBase);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const keys = await apiKeysApi.list();
        const stored = readApiKeyNames(apiBase);
        const next: Record<string, string> = {};
        for (const raw of keys ?? []) {
          const apiKey = typeof raw === 'string' ? raw : '';
          if (!apiKey) continue;
          const name = stored[apiKeyNameFingerprint(apiBase, apiKey)];
          if (name) next[collectorKeyId(apiKey)] = name;
        }
        if (!cancelled) setNames(next);
      } catch {
        // Without names the masked key still identifies each client.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);
  return names;
}
