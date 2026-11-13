/**
 * Pure transforms behind the dashboard charts.
 *
 * Everything here is derived from what CLIProxyAPI's v8 management API already
 * returns for each credential: `recent_requests` (the last twenty 10-minute
 * buckets of success and failure counts), cumulative `success`/`failed`
 * counters since the process started, and `quota.signals` (rate-limit headers
 * captured from the provider's latest response). Nothing is estimated.
 */
import type { AuthFileItem } from '@/types/authFile';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { normalizeRecentRequestUsageEntry } from '@/utils/recentRequests';
import { TRAFFIC_BUCKET_MINUTES } from './types';

export type ProviderFamily = 'claude' | 'codex' | 'other';

export const FAMILY_ORDER: ProviderFamily[] = ['claude', 'codex', 'other'];

/** The backend keeps 20 buckets of 10 minutes each. */
export const BUCKETS_PER_WINDOW = 20;

export interface RangeOption {
  id: string;
  buckets: number;
}

/** Ranges are cut from the 3h 20m the backend keeps; longer ranges do not exist. */
export const RANGE_OPTIONS: RangeOption[] = [
  { id: '1h', buckets: 6 },
  { id: '2h', buckets: 12 },
  { id: 'all', buckets: BUCKETS_PER_WINDOW },
];

export interface BucketCount {
  success: number;
  failed: number;
}

export interface LimitReading {
  /** 0 to 100. */
  usedPercent: number;
  resetAtMs: number | null;
  /** `usage` is a read of the provider's usage endpoint; `headers` came with a served request. */
  source: 'usage' | 'headers';
  observedAtMs: number | null;
}

export interface AccountLimits {
  fiveHour: LimitReading | null;
  weekly: LimitReading | null;
}

export interface AccountRow {
  key: string;
  name: string;
  family: ProviderFamily;
  provider: string;
  disabled: boolean;
  unavailable: boolean;
  /** Oldest first, always BUCKETS_PER_WINDOW long. */
  buckets: BucketCount[];
  /** Counters since the gateway process last started. */
  sinceStart: BucketCount;
  limits: AccountLimits;
}

export const familyOf = (provider: string): ProviderFamily => {
  const id = provider.trim().toLowerCase();
  if (id === 'claude' || id === 'anthropic') return 'claude';
  if (id === 'codex' || id === 'openai') return 'codex';
  return 'other';
};

const providerOf = (file: AuthFileItem): string =>
  String(file.type ?? file.provider ?? '')
    .trim()
    .toLowerCase() || 'unknown';

/** Display name: the account label or email. Never `account`, which can hold an API key. */
export const accountName = (file: AuthFileItem): string => {
  const label = typeof file.label === 'string' ? file.label.trim() : '';
  const email = typeof file.email === 'string' ? file.email.trim() : '';
  return label || email || file.name;
};

/** Pad or trim to the fixed window so buckets from every account line up by position. */
export const alignBuckets = (
  buckets: Array<{ success?: number; failed?: number }>,
  length = BUCKETS_PER_WINDOW
): BucketCount[] => {
  const tail = buckets.slice(-length).map((bucket) => ({
    success: Math.max(0, Number(bucket.success) || 0),
    failed: Math.max(0, Number(bucket.failed) || 0),
  }));
  const padding = Array.from({ length: length - tail.length }, () => ({ success: 0, failed: 0 }));
  return [...padding, ...tail];
};

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const epochToMs = (value: unknown): number | null => {
  const parsed = finite(value);
  if (parsed === null || parsed <= 0) return null;
  // Headers carry seconds; anything this large is already milliseconds.
  return parsed > 1e12 ? parsed : parsed * 1000;
};

const readSignals = (
  file: AuthFileItem
): { signals: Record<string, string>; observedAtMs: number | null } => {
  const quota = file.quota;
  if (!quota || typeof quota !== 'object') return { signals: {}, observedAtMs: null };
  const record = quota as Record<string, unknown>;
  const raw = record.signals;
  const signals: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        signals[key.toLowerCase()] = String(value);
      }
    }
  }
  const observed = typeof record.observed_at === 'string' ? Date.parse(record.observed_at) : NaN;
  return { signals, observedAtMs: Number.isFinite(observed) ? observed : null };
};

/**
 * Limits from the rate-limit headers the gateway stored with the latest response.
 * Anthropic reports utilization as a fraction (0.42); Codex reports a percent (42)
 * and names each window by its length in minutes.
 */
export const limitsFromHeaders = (file: AuthFileItem): AccountLimits => {
  const { signals, observedAtMs } = readSignals(file);
  const family = familyOf(providerOf(file));
  const empty: AccountLimits = { fiveHour: null, weekly: null };

  if (family === 'claude') {
    const reading = (window: '5h' | '7d'): LimitReading | null => {
      const utilization = finite(signals[`anthropic-ratelimit-unified-${window}-utilization`]);
      if (utilization === null) return null;
      return {
        usedPercent: clampPercent(utilization * 100),
        resetAtMs: epochToMs(signals[`anthropic-ratelimit-unified-${window}-reset`]),
        source: 'headers',
        observedAtMs,
      };
    };
    return { fiveHour: reading('5h'), weekly: reading('7d') };
  }

  if (family === 'codex') {
    const result: AccountLimits = { ...empty };
    for (const slot of ['primary', 'secondary'] as const) {
      const used = finite(signals[`x-codex-${slot}-used-percent`]);
      const minutes = finite(signals[`x-codex-${slot}-window-minutes`]);
      if (used === null || minutes === null || minutes <= 0) continue;
      const reading: LimitReading = {
        usedPercent: clampPercent(used),
        resetAtMs: epochToMs(signals[`x-codex-${slot}-reset-at`]),
        source: 'headers',
        observedAtMs,
      };
      if (minutes <= 5 * 60) result.fiveHour = result.fiveHour ?? reading;
      else if (minutes <= 7 * 24 * 60) result.weekly = result.weekly ?? reading;
    }
    return result;
  }

  return empty;
};

type UsageQuota = Pick<ClaudeQuotaState | CodexQuotaState, 'status' | 'windows'> & {
  observedAt?: string | null;
};

/** Limits from a usage read the Quota page (or the dashboard's read button) already made. */
export const limitsFromUsage = (quota: UsageQuota | undefined, weeklyId: string): AccountLimits => {
  if (!quota || quota.status !== 'success') return { fiveHour: null, weekly: null };
  const observed = quota.observedAt ? Date.parse(quota.observedAt) : NaN;
  const pick = (id: string): LimitReading | null => {
    const window = quota.windows.find((candidate) => candidate.id === id);
    if (!window || window.usedPercent === null || !Number.isFinite(window.usedPercent)) {
      return null;
    }
    return {
      usedPercent: clampPercent(window.usedPercent),
      resetAtMs: window.resetAtMs ?? null,
      source: 'usage',
      observedAtMs: Number.isFinite(observed) ? observed : null,
    };
  };
  return { fiveHour: pick('five-hour'), weekly: pick(weeklyId) };
};

/** A usage read wins over headers for each window it actually contains. */
export const mergeLimits = (usage: AccountLimits, headers: AccountLimits): AccountLimits => ({
  fiveHour: usage.fiveHour ?? headers.fiveHour,
  weekly: usage.weekly ?? headers.weekly,
});

export interface QuotaMaps {
  claude: Record<string, ClaudeQuotaState>;
  codex: Record<string, CodexQuotaState>;
}

export const buildAccountRows = (files: AuthFileItem[], quota: QuotaMaps): AccountRow[] =>
  files.map((file) => {
    const provider = providerOf(file);
    const family = familyOf(provider);
    const usage = normalizeRecentRequestUsageEntry(file);
    const cacheKey = getQuotaCacheKey(file);
    const fromUsage =
      family === 'claude'
        ? limitsFromUsage(quota.claude[cacheKey], 'seven-day')
        : family === 'codex'
          ? limitsFromUsage(quota.codex[cacheKey], 'weekly')
          : { fiveHour: null, weekly: null };
    return {
      key: `${file.name}\u0000${String(file.authIndex ?? '')}`,
      name: accountName(file),
      family,
      provider,
      disabled: Boolean(file.disabled),
      unavailable: Boolean(file.unavailable),
      buckets: alignBuckets(usage.recentRequests),
      sinceStart: { success: usage.success, failed: usage.failed },
      limits: mergeLimits(fromUsage, limitsFromHeaders(file)),
    };
  });

export const sumBuckets = (buckets: BucketCount[]): BucketCount =>
  buckets.reduce(
    (total, bucket) => ({
      success: total.success + bucket.success,
      failed: total.failed + bucket.failed,
    }),
    { success: 0, failed: 0 }
  );

/** Per-position totals across accounts, cut to the last `range` buckets. */
export const combineBuckets = (rows: AccountRow[], range: number): BucketCount[] => {
  const length = Math.min(range, BUCKETS_PER_WINDOW);
  const out = Array.from({ length }, () => ({ success: 0, failed: 0 }));
  for (const row of rows) {
    const slice = row.buckets.slice(-length);
    slice.forEach((bucket, index) => {
      out[index].success += bucket.success;
      out[index].failed += bucket.failed;
    });
  }
  return out;
};

export interface FamilySeries {
  family: ProviderFamily;
  /** Requests (success + failed) per bucket. */
  values: number[];
  total: number;
  failed: number;
}

export const seriesByFamily = (rows: AccountRow[], range: number): FamilySeries[] =>
  FAMILY_ORDER.map((family) => {
    const buckets = combineBuckets(
      rows.filter((row) => row.family === family),
      range
    );
    const totals = sumBuckets(buckets);
    return {
      family,
      values: buckets.map((bucket) => bucket.success + bucket.failed),
      total: totals.success + totals.failed,
      failed: totals.failed,
    };
  }).filter((series) => rows.some((row) => row.family === series.family));

/** Success share per bucket, null where a bucket served nothing. */
export const successRateSeries = (buckets: BucketCount[]): Array<number | null> =>
  buckets.map((bucket) => {
    const total = bucket.success + bucket.failed;
    return total > 0 ? (bucket.success / total) * 100 : null;
  });

export interface ShareSplit {
  claudeShare: number | null;
  codexShare: number | null;
  /** Claude share minus Codex share, in percentage points. */
  leadPoints: number | null;
}

/** Claude against Codex only, the way the headline compares them. */
export const claudeCodexSplit = (series: FamilySeries[]): ShareSplit => {
  const claude = series.find((item) => item.family === 'claude')?.total ?? 0;
  const codex = series.find((item) => item.family === 'codex')?.total ?? 0;
  const total = claude + codex;
  if (total === 0) return { claudeShare: null, codexShare: null, leadPoints: null };
  const claudeShare = (claude / total) * 100;
  const codexShare = 100 - claudeShare;
  return { claudeShare, codexShare, leadPoints: claudeShare - codexShare };
};

/** Minutes before now at which bucket `index` (of `count`, oldest first) ends. */
export const bucketEndsMinutesAgo = (index: number, count: number): number =>
  (count - 1 - index) * TRAFFIC_BUCKET_MINUTES;
