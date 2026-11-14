/**
 * Request history from Intent's usage collector (deploy/usage-collector).
 *
 * CLIProxyAPI publishes one record per request to a queue that deletes records once read
 * and keeps them for about a minute. The collector, a loopback-only service on the same
 * host, is the only reader: it drains the queue every few seconds into SQLite and serves
 * summaries and the request log. The panel reaches it through the management api-call
 * proxy (GET only, no credential attached) and never reads the queue itself.
 */
import { apiCallApi } from './apiCall';
import { isRecord } from '@/utils/helpers';

export const USAGE_COLLECTOR_URL = 'http://127.0.0.1:8337';

export interface TokenTotals {
  requests: number;
  failed: number;
  inputUncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  unpricedRequests: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  ttftP50Ms: number | null;
}

export interface UsageBucket extends TokenTotals {
  /** Bucket start, epoch ms. */
  t: number;
  byProvider: Record<string, { requests: number; tokens: number; costUsd: number }>;
}

export interface UsageGroup extends TokenTotals {
  id: string;
  label: string;
  provider: string | null;
  /** "codex-lb" when the account is reached through codex-lb. */
  via: string | null;
}

export interface PriceSource {
  name: string;
  url: string | null;
  fetchedAt: string | null;
}

export interface UsageSummary {
  totals: TokenTotals;
  series: UsageBucket[];
  byModel: UsageGroup[];
  byAccount: UsageGroup[];
  byKey: UsageGroup[];
  byProvider: UsageGroup[];
  firstRecordAtMs: number | null;
  oldestRawAtMs: number | null;
  priceSource: PriceSource | null;
}

export interface UsageRequest {
  id: number;
  ts: number;
  sourceOrigin: string | null;
  provider: string | null;
  model: string | null;
  alias: string | null;
  accountId: string | null;
  accountLabel: string | null;
  via: string | null;
  keyId: string | null;
  keyMasked: string | null;
  endpoint: string | null;
  stream: boolean | null;
  inputUncached: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  costUsd: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  statusCode: number | null;
  failed: boolean;
  error: string | null;
  requestId?: string | null;
  userAgent?: string | null;
}

export interface UsageRequestPage {
  items: UsageRequest[];
  nextBefore: number | null;
}

export interface UsageHealth {
  ok: boolean;
  lastDrainAtMs: number | null;
  firstRecordAtMs: number | null;
  collectorStartedAtMs: number | null;
  oldestRawAtMs: number | null;
  priceSource: PriceSource | null;
}

export interface UsageFilters {
  from: number;
  to: number;
  provider?: string;
  model?: string;
  account?: string;
  key?: string;
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const totalsFrom = (raw: Record<string, unknown>): TokenTotals => ({
  requests: num(raw.requests),
  failed: num(raw.failed),
  inputUncached: num(raw.input_uncached),
  cacheRead: num(raw.cache_read),
  cacheWrite: num(raw.cache_write),
  output: num(raw.output),
  reasoning: num(raw.reasoning),
  costUsd: num(raw.cost_usd),
  unpricedRequests: num(raw.unpriced_requests),
  latencyP50Ms: numOrNull(raw.latency_p50_ms),
  latencyP95Ms: numOrNull(raw.latency_p95_ms),
  ttftP50Ms: numOrNull(raw.ttft_p50_ms),
});

/** Provider for a model name when the collector's group does not say. */
const providerForModel = (model: string): string | null =>
  /^claude/i.test(model) ? 'claude' : /^(gpt|o\d|codex)/i.test(model) ? 'codex' : null;

const groupFrom = (raw: unknown, idKey: string, labelKey: string): UsageGroup | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw[idKey]) ?? str(raw.id) ?? '';
  return {
    ...totalsFrom(raw),
    id,
    label: str(raw[labelKey]) ?? str(raw.label) ?? id,
    provider: str(raw.provider) ?? (idKey === 'model' ? providerForModel(id) : null),
    via: str(raw.via),
  };
};

const groups = (raw: unknown, idKey: string, labelKey: string): UsageGroup[] =>
  Array.isArray(raw)
    ? raw
        .map((item) => groupFrom(item, idKey, labelKey))
        .filter((item): item is UsageGroup => item !== null)
    : [];

const priceSourceFrom = (raw: unknown): PriceSource | null =>
  isRecord(raw)
    ? { name: str(raw.name) ?? '', url: str(raw.url), fetchedAt: str(raw.fetched_at) }
    : null;

/** Sum of every token type, the "tokens burned" figure. Reasoning is inside output. */
export const totalTokens = (
  totals: Pick<TokenTotals, 'inputUncached' | 'cacheRead' | 'cacheWrite' | 'output'>
): number => totals.inputUncached + totals.cacheRead + totals.cacheWrite + totals.output;

/** Share of prompt tokens served from cache. */
export const cacheHitRate = (totals: TokenTotals): number | null => {
  const prompt = totals.inputUncached + totals.cacheRead + totals.cacheWrite;
  return prompt > 0 ? totals.cacheRead / prompt : null;
};

export const errorRate = (totals: TokenTotals): number | null =>
  totals.requests > 0 ? totals.failed / totals.requests : null;

const requestFrom = (raw: unknown): UsageRequest | null => {
  if (!isRecord(raw)) return null;
  const id = numOrNull(raw.id);
  const ts = numOrNull(raw.ts);
  if (id === null || ts === null) return null;
  return {
    id,
    ts,
    sourceOrigin: str(raw.source_origin),
    provider: str(raw.provider),
    model: str(raw.model),
    alias: str(raw.alias),
    accountId: str(raw.account_id),
    accountLabel: str(raw.account_label),
    via: str(raw.via),
    keyId: str(raw.key_id),
    keyMasked: str(raw.key_masked),
    endpoint: str(raw.endpoint),
    stream: typeof raw.stream === 'boolean' ? raw.stream : null,
    inputUncached: num(raw.input_uncached),
    cacheRead: num(raw.cache_read),
    cacheWrite5m: num(raw.cache_write_5m),
    cacheWrite1h: num(raw.cache_write_1h),
    output: num(raw.output),
    reasoning: num(raw.reasoning),
    costUsd: numOrNull(raw.cost_usd),
    latencyMs: numOrNull(raw.latency_ms),
    ttftMs: numOrNull(raw.ttft_ms),
    statusCode: numOrNull(raw.status_code),
    failed: raw.failed === true || raw.failed === 1,
    error: str(raw.error),
    requestId: str(raw.request_id),
    userAgent: str(raw.user_agent),
  };
};

export class UsageCollectorError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'bad_response'
  ) {
    super(message);
  }
}

const get = async (path: string, params: object) => {
  const query = Object.entries(params as Record<string, string | number | undefined>)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  let result;
  try {
    result = await apiCallApi.request(
      {
        method: 'GET',
        url: `${USAGE_COLLECTOR_URL}${path}${query ? `?${query}` : ''}`,
        header: { Accept: 'application/json' },
      },
      { timeout: 30_000 }
    );
  } catch {
    throw new UsageCollectorError('The usage collector is not answering.', 'unreachable');
  }
  if (result.statusCode !== 200 || !isRecord(result.body)) {
    throw new UsageCollectorError(
      result.statusCode >= 500 || result.statusCode === 0
        ? 'The usage collector is not answering.'
        : `The usage collector answered HTTP ${result.statusCode}.`,
      result.statusCode >= 500 || result.statusCode === 0 ? 'unreachable' : 'bad_response'
    );
  }
  return result.body;
};

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const usageApi = {
  summary: async (filters: UsageFilters, bucket: 'hour' | 'day'): Promise<UsageSummary> => {
    const body = await get('/v1/summary', { ...filters, bucket, tz: timeZone() });
    const coverage = isRecord(body.coverage) ? body.coverage : {};
    return {
      totals: totalsFrom(isRecord(body.totals) ? body.totals : {}),
      series: Array.isArray(body.series)
        ? body.series.filter(isRecord).map((bucketRaw) => ({
            ...totalsFrom(bucketRaw),
            t: num(bucketRaw.t),
            byProvider: Object.fromEntries(
              Object.entries(isRecord(bucketRaw.by_provider) ? bucketRaw.by_provider : {}).map(
                ([name, value]) => [
                  name,
                  isRecord(value)
                    ? {
                        requests: num(value.requests),
                        tokens: num(value.tokens),
                        costUsd: num(value.cost_usd),
                      }
                    : { requests: 0, tokens: 0, costUsd: 0 },
                ]
              )
            ),
          }))
        : [],
      byModel: groups(body.by_model, 'model', 'model'),
      byAccount: groups(body.by_account, 'account_id', 'label'),
      byKey: groups(body.by_key, 'key_id', 'key_masked'),
      byProvider: groups(body.by_provider, 'provider', 'provider'),
      firstRecordAtMs: numOrNull(coverage.first_record_at),
      oldestRawAtMs: numOrNull(coverage.oldest_raw_at),
      priceSource: priceSourceFrom(body.price_source),
    };
  },

  requests: async (
    filters: UsageFilters & {
      q?: string;
      status?: 'ok' | 'failed';
      limit?: number;
      before?: number;
    }
  ): Promise<UsageRequestPage> => {
    const body = await get('/v1/requests', filters);
    return {
      items: Array.isArray(body.items)
        ? body.items.map(requestFrom).filter((item): item is UsageRequest => item !== null)
        : [],
      nextBefore: numOrNull(body.next_before),
    };
  },

  request: async (id: number): Promise<UsageRequest | null> => {
    const body = await get(`/v1/requests/${encodeURIComponent(String(id))}`, {});
    return requestFrom(isRecord(body.item) ? body.item : body);
  },

  health: async (): Promise<UsageHealth> => {
    const body = await get('/v1/health', {});
    return {
      ok: body.ok === true,
      lastDrainAtMs: numOrNull(body.last_drain_at),
      firstRecordAtMs: numOrNull(body.first_record_at),
      collectorStartedAtMs: numOrNull(body.collector_started_at),
      oldestRawAtMs: numOrNull(body.oldest_raw_at),
      priceSource: priceSourceFrom(body.price_source),
    };
  },
};
