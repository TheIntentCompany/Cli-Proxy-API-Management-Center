/**
 * Requests: every request the gateway served, newest first, with the client key that sent
 * it, the model, the account that served it, tokens, cost, latency and status. Answers
 * "which request went to which account". Filters narrow by range, status, provider,
 * model, account and client key; search matches model, account, key, request id or error.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Sheet } from '@/components/ui/Sheet/Sheet';
import { Badge, ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { IconSearch } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { usageApi, type UsageRequest } from '@/services/api/usage';
import { formatCount, formatMs, formatTokens, formatUsd } from './format';
import { useClientKeyNames, useUsageSummary } from './hooks';
import { providerName } from './chart';
import { RangePicker } from './RangePicker';
import { resolveRange, useUsageRange } from './range';
import styles from './usage.module.scss';

const PAGE_SIZE = 50;

type Status = 'all' | 'ok' | 'failed';

export function RequestsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const { range, setRange } = useUsageRange();
  const resolved = useMemo(() => resolveRange(range, now, null), [range, now]);
  const keyNames = useClientKeyNames();

  const status = (params.get('status') as Status | null) ?? 'all';
  const model = params.get('model') ?? '';
  const account = params.get('account') ?? '';
  const key = params.get('key') ?? '';
  const provider = params.get('provider') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const setParam = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  };

  // Options for the filter menus come from the same range's summary.
  const optionFilters = useMemo(() => ({ from: resolved.from, to: resolved.to }), [resolved]);
  const { summary } = useUsageSummary(optionFilters, resolved.bucket);

  // Cursor pagination: the stack holds the "before" cursor of each page shown so far.
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [items, setItems] = useState<UsageRequest[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<UsageRequest | null>(null);
  const requestRef = useRef(0);

  // The minute clock moves the range end; pin it per filter set so pages stay stable.
  const pinnedTo = useMemo(
    () => resolved.to,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, status, model, account, key, provider, debouncedQuery]
  );
  const filterKey = JSON.stringify([
    resolved.from,
    pinnedTo,
    status,
    model,
    account,
    key,
    provider,
    debouncedQuery,
  ]);
  useEffect(() => {
    setCursors([undefined]);
  }, [filterKey]);

  const page = cursors.length;
  const before = cursors[cursors.length - 1];

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    setLoading(true);
    try {
      const result = await usageApi.requests({
        from: resolved.from,
        to: pinnedTo,
        q: debouncedQuery || undefined,
        status: status === 'all' ? undefined : status,
        model: model || undefined,
        account: account || undefined,
        key: key || undefined,
        provider: provider || undefined,
        limit: PAGE_SIZE,
        before,
      });
      if (id !== requestRef.current) return;
      setItems(result.items);
      setNextBefore(result.nextBefore);
      setError(null);
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, before]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (row: UsageRequest) => {
    setDetail(row);
    try {
      const full = await usageApi.request(row.id);
      if (full) setDetail(full);
    } catch {
      // The list row already has everything but the full error text.
    }
  };

  const keyLabel = (row: Pick<UsageRequest, 'keyId' | 'keyMasked'>) =>
    (row.keyId && keyNames[row.keyId]) || row.keyMasked || t('usage.no_key');
  const time = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  const unknown = t('usage.unknown');
  const filtered = Boolean(
    status !== 'all' || model || account || key || provider || debouncedQuery
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1>{t('usage.requests_title')}</h1>
          <p>{t('usage.requests_subtitle')}</p>
        </div>
        <div className={styles.controls}>
          <RangePicker range={range} onChange={setRange} />
        </div>
      </header>

      <div className={styles.filterBar}>
        <label className={styles.searchBox}>
          <IconSearch size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={t('usage.search_placeholder')}
            aria-label={t('usage.search_placeholder')}
            onChange={(event) => {
              setQuery(event.target.value);
              setParam('q', event.target.value.trim());
            }}
          />
        </label>
        <div className={styles.segmented} role="group" aria-label={t('usage.col_status')}>
          {(['all', 'ok', 'failed'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className={status === id ? styles.segmentActive : styles.segment}
              aria-pressed={status === id}
              onClick={() => setParam('status', id === 'all' ? '' : id)}
            >
              {t(`usage.status_${id}`)}
            </button>
          ))}
        </div>
        <FilterSelect
          label={t('usage.col_model')}
          value={model}
          allLabel={t('usage.all_models')}
          options={(summary?.byModel ?? []).map((group) => ({
            value: group.id,
            label: group.label,
          }))}
          onChange={(value) => setParam('model', value)}
        />
        <FilterSelect
          label={t('usage.col_account')}
          value={account}
          allLabel={t('usage.all_accounts')}
          options={(summary?.byAccount ?? []).map((group) => ({
            value: group.id,
            label: group.label || group.id,
          }))}
          onChange={(value) => setParam('account', value)}
        />
        <FilterSelect
          label={t('usage.col_key')}
          value={key}
          allLabel={t('usage.all_keys')}
          options={(summary?.byKey ?? []).map((group) => ({
            value: group.id,
            label: keyNames[group.id] ?? group.label,
          }))}
          onChange={(value) => setParam('key', value)}
        />
        {filtered && (
          <button
            type="button"
            className={styles.ghostButton}
            onClick={() => {
              setQuery('');
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            {t('usage.clear_filters')}
          </button>
        )}
      </div>

      {error && (
        <ErrorNotice
          error={t('usage.collector_unreachable')}
          details={error}
          detailsLabel={t('common.details', { defaultValue: 'Details' })}
        />
      )}

      <div className={styles.tableWrap} aria-busy={loading || undefined}>
        <table className={`${styles.table} ${styles.requestsTable}`}>
          <thead>
            <tr>
              <th>{t('usage.col_time')}</th>
              <th className={styles.colKey}>{t('usage.col_key')}</th>
              <th>{t('usage.col_model')}</th>
              <th>{t('usage.col_account')}</th>
              <th className={styles.num}>{t('usage.col_tokens_in_out')}</th>
              <th className={styles.num}>{t('usage.col_cost')}</th>
              <th className={styles.num}>{t('usage.col_latency')}</th>
              <th>{t('usage.col_status')}</th>
            </tr>
          </thead>
          <tbody>
            {items?.map((row) => (
              <tr key={row.id} className={styles.clickable}>
                <td className={styles.nowrap}>
                  <button
                    type="button"
                    className={styles.rowButton}
                    onClick={() => void openDetail(row)}
                  >
                    {time(row.ts)}
                  </button>
                </td>
                <td className={styles.colKey}>
                  <MiddleTruncate className={styles.cellText} value={keyLabel(row)} />
                </td>
                <td>
                  <MiddleTruncate className={styles.cellText} value={row.model ?? unknown} />
                  {/* Narrow tables drop the client key column and show the key here. */}
                  <span className={`${styles.rowSub} ${styles.keyInline}`}>{keyLabel(row)}</span>
                </td>
                <td>
                  <MiddleTruncate
                    className={styles.cellText}
                    value={row.accountLabel ?? row.accountId ?? unknown}
                  />
                  {row.via && (
                    <span className={styles.rowSub}>{t('usage.via', { via: row.via })}</span>
                  )}
                </td>
                <td className={`${styles.num} ${styles.nowrap}`}>
                  {formatTokens(
                    row.inputUncached + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h
                  )}
                  <span className={styles.muted}> → </span>
                  {formatTokens(row.output)}
                </td>
                <td className={styles.num}>
                  {row.costUsd === null ? (
                    <span className={styles.muted}>–</span>
                  ) : (
                    formatUsd(row.costUsd)
                  )}
                </td>
                <td className={`${styles.num} ${styles.muted}`}>{formatMs(row.latencyMs)}</td>
                <td>
                  {row.failed ? (
                    <Badge variant="error">{row.statusCode ?? t('usage.status_failed')}</Badge>
                  ) : (
                    <span className={styles.muted}>{row.statusCode ?? 200}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items && items.length === 0 && (
          <div className={styles.chartEmpty}>
            {filtered ? t('usage.no_matching_requests') : t('usage.empty_range')}
          </div>
        )}
        {!items && !error && <div className={styles.loading}>{t('common.loading')}</div>}
      </div>

      <div className={styles.pager}>
        <span className={styles.muted}>
          {items ? t('usage.page_info', { page, count: formatCount(items.length) }) : ''}
        </span>
        <div>
          <button
            type="button"
            className={styles.outlineButton}
            disabled={page <= 1 || loading}
            onClick={() => setCursors((stack) => stack.slice(0, -1))}
          >
            {t('usage.newer')}
          </button>
          <button
            type="button"
            className={styles.outlineButton}
            disabled={nextBefore === null || loading}
            onClick={() => setCursors((stack) => [...stack, nextBefore ?? undefined])}
          >
            {t('usage.older')}
          </button>
        </div>
      </div>

      <Sheet
        open={detail !== null}
        onClose={() => setDetail(null)}
        title={detail ? (detail.model ?? unknown) : ''}
        description={detail ? time(detail.ts) : undefined}
      >
        {detail && (
          <div className={styles.detail}>
            {detail.failed && (
              <ErrorNotice
                error={detail.error || t('usage.status_failed')}
                detailsLabel={t('common.details', { defaultValue: 'Details' })}
              />
            )}
            <dl className={styles.detailList}>
              <Field label={t('usage.col_status')}>
                {detail.statusCode ?? (detail.failed ? t('usage.status_failed') : 200)}
              </Field>
              <Field label={t('usage.col_key')}>{keyLabel(detail)}</Field>
              <Field label={t('usage.col_account')}>
                {detail.accountLabel ?? detail.accountId ?? unknown}
                {detail.via ? ` · ${t('usage.via', { via: detail.via })}` : ''}
              </Field>
              <Field label={t('usage.col_provider')}>
                {providerName(detail.provider, unknown)}
              </Field>
              {detail.alias && detail.alias !== detail.model && (
                <Field label={t('usage.requested_model')}>{detail.alias}</Field>
              )}
              <Field label={t('usage.endpoint')}>{detail.endpoint ?? '–'}</Field>
              <Field label={t('usage.token_uncached')}>{formatCount(detail.inputUncached)}</Field>
              <Field label={t('usage.token_cache_read')}>{formatCount(detail.cacheRead)}</Field>
              <Field label={t('usage.token_cache_write')}>
                {formatCount(detail.cacheWrite5m + detail.cacheWrite1h)}
                {detail.cacheWrite1h > 0 &&
                  ` (${t('usage.one_hour', { count: detail.cacheWrite1h })})`}
              </Field>
              <Field label={t('usage.token_output')}>
                {formatCount(detail.output)}
                {detail.reasoning > 0 &&
                  ` (${t('usage.reasoning_inline', { count: formatCount(detail.reasoning) })})`}
              </Field>
              <Field label={t('usage.col_cost')}>
                {detail.costUsd === null ? t('usage.unpriced') : formatUsd(detail.costUsd)}
              </Field>
              <Field label={t('usage.col_latency')}>{formatMs(detail.latencyMs)}</Field>
              <Field label={t('usage.stat_ttft')}>{formatMs(detail.ttftMs)}</Field>
              {detail.requestId && <Field label={t('common.request_id')}>{detail.requestId}</Field>}
              <Field label={t('usage.recorded_by')}>
                {detail.sourceOrigin === 'codex-lb' ? 'codex-lb' : 'CLIProxyAPI'}
              </Field>
            </dl>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string;
  allLabel: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  // Keep a filter from a link visible even when this range has no such rows.
  const withCurrent =
    value && !options.some((option) => option.value === value)
      ? [...options, { value, label: value }]
      : options;
  return (
    <select
      className={styles.select}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{allLabel}</option>
      {withCurrent.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
