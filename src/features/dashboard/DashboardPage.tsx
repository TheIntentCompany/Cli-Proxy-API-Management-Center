/**
 * Overview: what this gateway served over a chosen range, from the usage collector's
 * request history. Modelled on T3 Code's usage page (MIT, see THIRD_PARTY_NOTICES.md):
 * one headline figure with its split by provider, the same figure over time, where the
 * tokens went, how healthy the traffic was, and a breakdown by model, account, client key
 * or time. Every figure answers a question someone running the gateway asks.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { useNow } from '@/hooks/useNow';
import {
  cacheHitRate,
  errorRate,
  totalTokens,
  type TokenTotals,
  type UsageGroup,
} from '@/services/api/usage';
import {
  formatCount,
  formatMs,
  formatPercent,
  formatTokens,
  formatUsd,
} from '@/features/usage/format';
import { useClientKeyNames, useUsageSummary } from '@/features/usage/hooks';
import { RangePicker } from '@/features/usage/RangePicker';
import { resolveRange, useUsageRange } from '@/features/usage/range';
import { ShareBar } from '@/features/usage/ShareBar';
import { bucketLabel, evenTicks, providerColor, providerName } from '@/features/usage/chart';
import { Stat } from '@/features/usage/Stat';
import { ModelDialog } from '@/features/usage/ModelDialog';
import { LineChart } from './components/LineChart';
import styles from '@/features/usage/usage.module.scss';

type Metric = 'tokens' | 'cost' | 'requests';
type Breakdown = 'model' | 'account' | 'key' | 'time';

const METRIC_KEY = 'intent.usage.metric';
const TOKEN_COLORS = {
  uncached: 'var(--viz-codex)',
  cacheRead: 'color-mix(in srgb, var(--viz-codex) 45%, transparent)',
  cacheWrite: 'var(--viz-claude)',
  output: 'var(--t3-primary)',
};

const metricValue = (totals: TokenTotals, metric: Metric) =>
  metric === 'tokens' ? totalTokens(totals) : metric === 'cost' ? totals.costUsd : totals.requests;

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const { range, setRange } = useUsageRange();
  const [metric, setMetricState] = useState<Metric>(() => {
    const stored = localStorage.getItem(METRIC_KEY);
    return stored === 'cost' || stored === 'requests' ? stored : 'tokens';
  });
  const setMetric = (next: Metric) => {
    setMetricState(next);
    localStorage.setItem(METRIC_KEY, next);
  };
  const [breakdown, setBreakdown] = useState<Breakdown>('model');
  const [firstRecordAt, setFirstRecordAt] = useState<number | null>(null);
  const [modelOpen, setModelOpen] = useState<string | null>(null);

  const resolved = useMemo(
    () => resolveRange(range, now, firstRecordAt),
    [range, now, firstRecordAt]
  );
  const filters = useMemo(() => ({ from: resolved.from, to: resolved.to }), [resolved]);
  const { summary, error, loading } = useUsageSummary(filters, resolved.bucket);
  const keyNames = useClientKeyNames();

  // "All time" starts at the earliest stored row: the codex-lb backfill can predate the
  // gateway queue's first record.
  const earliest = useMemo(() => {
    const dates = [summary?.firstRecordAtMs, summary?.oldestRawAtMs].filter(
      (value): value is number => typeof value === 'number' && value > 0
    );
    return dates.length > 0 ? Math.min(...dates) : null;
  }, [summary?.firstRecordAtMs, summary?.oldestRawAtMs]);
  useEffect(() => {
    if (earliest) setFirstRecordAt(earliest);
  }, [earliest]);

  const unknown = t('usage.unknown');
  const format = (value: number, which: Metric = metric) =>
    which === 'tokens'
      ? formatTokens(value)
      : which === 'cost'
        ? formatUsd(value)
        : formatCount(value);

  const totals = summary?.totals;
  const providers = useMemo(
    () =>
      [...(summary?.byProvider ?? [])]
        .filter((group) => group.requests > 0)
        .sort((a, b) => metricValue(b, metric) - metricValue(a, metric)),
    [summary, metric]
  );
  const grand = totals ? metricValue(totals, metric) : 0;

  const gatewayStart = summary?.firstRecordAtMs ?? null;
  const bucketMs = resolved.bucket === 'hour' ? 3_600_000 : 86_400_000;
  const series = useMemo(
    () =>
      providers.map((group) => ({
        id: group.id,
        label: providerName(group.id, unknown),
        color: providerColor(group.id),
        values: (summary?.series ?? []).map((bucket) => {
          const entry = bucket.byProvider[group.id];
          // Before the gateway's history begins, an empty bucket means "not recorded",
          // not "no traffic": leave a gap instead of drawing zero.
          if (
            (!entry || entry.requests === 0) &&
            gatewayStart !== null &&
            bucket.t + bucketMs <= gatewayStart
          ) {
            return null;
          }
          if (!entry) return 0;
          return metric === 'tokens'
            ? entry.tokens
            : metric === 'cost'
              ? entry.costUsd
              : entry.requests;
        }),
      })),
    [providers, summary, metric, unknown, gatewayStart, bucketMs]
  );
  const buckets = summary?.series ?? [];
  const startsBeforeHistory = gatewayStart !== null && resolved.from < gatewayStart;

  const chartTitle = t(`usage.chart_${metric}_${resolved.bucket}`);
  const empty = summary !== null && (totals?.requests ?? 0) === 0;

  const groupsFor = (which: Breakdown): UsageGroup[] => {
    const list =
      which === 'model'
        ? summary?.byModel
        : which === 'account'
          ? summary?.byAccount
          : summary?.byKey;
    return [...(list ?? [])].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
  };
  const groupLabel = (which: Breakdown, group: UsageGroup) =>
    which === 'key' ? (keyNames[group.id] ?? group.label) : group.label || unknown;

  const when = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const coverage = summary?.firstRecordAtMs
    ? earliest !== null && earliest < summary.firstRecordAtMs - 3_600_000
      ? t('usage.coverage_backfill', {
          date: when(summary.firstRecordAtMs),
          backfill: when(earliest),
        })
      : t('usage.coverage', { date: when(summary.firstRecordAtMs) })
    : null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1>{t('usage.overview_title')}</h1>
          <p>{t('usage.overview_subtitle')}</p>
        </div>
        <div className={styles.controls}>
          <RangePicker range={range} onChange={setRange} />
          <div className={styles.segmented} role="group" aria-label={t('usage.metric_label')}>
            {(['tokens', 'cost', 'requests'] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={metric === id ? styles.segmentActive : styles.segment}
                aria-pressed={metric === id}
                onClick={() => setMetric(id)}
              >
                {t(`usage.metric_${id}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error && (
        <ErrorNotice
          error={summary ? t('usage.stale_error') : t('usage.collector_unreachable')}
          details={error}
          detailsLabel={t('common.details', { defaultValue: 'Details' })}
        />
      )}

      {!summary && !error && <div className={styles.loading}>{t('common.loading')}</div>}

      {summary && totals && (
        <>
          <section className={styles.hero} aria-busy={loading || undefined}>
            <div className={styles.heroSide}>
              <div className={styles.headline}>
                <span className={styles.headlineValue}>{format(grand)}</span>
                <span className={styles.headlineMeta}>
                  {metric === 'tokens'
                    ? t('usage.headline_tokens', { requests: formatCount(totals.requests) })
                    : metric === 'cost'
                      ? t('usage.headline_cost', { tokens: formatTokens(totalTokens(totals)) })
                      : t('usage.headline_requests', { failed: formatPercent(errorRate(totals)) })}
                </span>
              </div>
              {providers.map((group) => {
                const value = metricValue(group, metric);
                return (
                  <div key={group.id} className={styles.providerRow}>
                    <div className={styles.providerTop}>
                      <span className={styles.providerName}>
                        <i style={{ background: providerColor(group.id) }} aria-hidden="true" />
                        {providerName(group.id, unknown)}
                      </span>
                      <span className={styles.providerValue}>{format(value)}</span>
                    </div>
                    <span className={styles.providerMeta}>
                      {t('usage.provider_share', {
                        share: formatPercent(grand > 0 ? value / grand : null),
                        metric: t(`usage.metric_${metric}`).toLowerCase(),
                      })}
                      {' · '}
                      {metric === 'cost'
                        ? `${formatTokens(totalTokens(group))} ${t('usage.tokens_word')}`
                        : formatUsd(group.costUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={styles.heroChart}>
              <h2>{chartTitle}</h2>
              {empty ? (
                <div className={styles.chartEmpty}>{t('usage.empty_range')}</div>
              ) : (
                <LineChart
                  series={series}
                  ariaLabel={chartTitle}
                  xLabel={(index) => bucketLabel(buckets[index]?.t ?? 0, resolved.bucket, locale)}
                  xTicks={evenTicks(buckets.length)}
                  yFormat={(value) => format(value)}
                  valueFormat={(value) => format(value)}
                  endValue={(id) => {
                    const group = providers.find((item) => item.id === id);
                    return group ? format(metricValue(group, metric)) : '';
                  }}
                  height={300}
                  extraRows={(index) => {
                    const bucket = buckets[index];
                    if (!bucket) return [];
                    return [
                      { label: t('usage.requests_word'), value: formatCount(bucket.requests) },
                      ...(bucket.failed > 0
                        ? [{ label: t('usage.failed_word'), value: formatCount(bucket.failed) }]
                        : []),
                    ];
                  }}
                />
              )}
              <p className={styles.chartNote}>
                {t('usage.chart_note')}
                {startsBeforeHistory && ` ${t('usage.chart_gap_note')}`}
              </p>
            </div>
          </section>

          {!empty && (
            <>
              <section className={styles.section}>
                <ShareBar
                  label={t('usage.tokens_by_type')}
                  format={formatTokens}
                  note={
                    totals.reasoning > 0
                      ? t('usage.reasoning_note', { tokens: formatTokens(totals.reasoning) })
                      : undefined
                  }
                  segments={[
                    {
                      label: t('usage.token_uncached'),
                      value: totals.inputUncached,
                      color: TOKEN_COLORS.uncached,
                    },
                    {
                      label: t('usage.token_cache_read'),
                      value: totals.cacheRead,
                      color: TOKEN_COLORS.cacheRead,
                    },
                    {
                      label: t('usage.token_cache_write'),
                      value: totals.cacheWrite,
                      color: TOKEN_COLORS.cacheWrite,
                    },
                    {
                      label: t('usage.token_output'),
                      value: totals.output,
                      color: TOKEN_COLORS.output,
                    },
                  ]}
                />
              </section>

              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('usage.health_title')}</h2>
                <div className={styles.stats}>
                  <Stat
                    label={t('usage.stat_requests')}
                    value={formatCount(totals.requests)}
                    hint={t('usage.stat_requests_hint')}
                  />
                  <Stat
                    label={t('usage.stat_errors')}
                    value={formatPercent(errorRate(totals))}
                    hint={t('usage.stat_errors_hint', { count: totals.failed })}
                    tone={(errorRate(totals) ?? 0) >= 0.05 ? 'error' : undefined}
                  />
                  <Stat
                    label={t('usage.stat_cache')}
                    value={formatPercent(cacheHitRate(totals))}
                    hint={t('usage.stat_cache_hint')}
                  />
                  <Stat
                    label={t('usage.stat_p50')}
                    value={formatMs(totals.latencyP50Ms)}
                    hint={t('usage.stat_p50_hint')}
                  />
                  <Stat
                    label={t('usage.stat_p95')}
                    value={formatMs(totals.latencyP95Ms)}
                    hint={t('usage.stat_p95_hint')}
                  />
                  <Stat
                    label={t('usage.stat_ttft')}
                    value={formatMs(totals.ttftP50Ms)}
                    hint={t('usage.stat_ttft_hint')}
                  />
                </div>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>{t('usage.breakdown_title')}</h2>
                  <div
                    className={styles.segmented}
                    role="group"
                    aria-label={t('usage.breakdown_title')}
                  >
                    {(['model', 'account', 'key', 'time'] as const).map((id) => (
                      <button
                        key={id}
                        type="button"
                        className={breakdown === id ? styles.segmentActive : styles.segment}
                        aria-pressed={breakdown === id}
                        onClick={() => setBreakdown(id)}
                      >
                        {id === 'time'
                          ? t(`usage.breakdown_time_${resolved.bucket}`)
                          : t(`usage.breakdown_${id}`)}
                      </button>
                    ))}
                  </div>
                </div>

                {breakdown !== 'time' ? (
                  <BreakdownTable
                    groups={groupsFor(breakdown)}
                    label={(group) => groupLabel(breakdown, group)}
                    secondary={(group) =>
                      breakdown === 'account'
                        ? [
                            providerName(group.provider, unknown),
                            group.via ? t('usage.via', { via: group.via }) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        : breakdown === 'key'
                          ? keyNames[group.id]
                            ? group.label
                            : null
                          : providerName(group.provider, unknown)
                    }
                    metric={metric}
                    grand={grand}
                    onOpen={
                      breakdown === 'model'
                        ? (group) => setModelOpen(group.id)
                        : breakdown === 'account'
                          ? () => navigate('/auth-files')
                          : (group) => navigate(`/requests?key=${encodeURIComponent(group.id)}`)
                    }
                    nameHeader={t(`usage.breakdown_${breakdown}`)}
                  />
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>{t(`usage.breakdown_time_${resolved.bucket}`)}</th>
                          {providers.map((group) => (
                            <th key={group.id} className={styles.num}>
                              {providerName(group.id, unknown)}
                            </th>
                          ))}
                          <th className={styles.num}>{t('usage.col_total')}</th>
                          <th className={styles.num}>{t('usage.col_requests')}</th>
                          <th className={styles.num}>{t('usage.col_errors')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...buckets]
                          .reverse()
                          .filter((bucket) => bucket.requests > 0)
                          .map((bucket) => (
                            <tr key={bucket.t}>
                              <td>{bucketLabel(bucket.t, resolved.bucket, locale)}</td>
                              {providers.map((group) => {
                                const entry = bucket.byProvider[group.id];
                                const value = !entry
                                  ? 0
                                  : metric === 'tokens'
                                    ? entry.tokens
                                    : metric === 'cost'
                                      ? entry.costUsd
                                      : entry.requests;
                                return (
                                  <td key={group.id} className={`${styles.num} ${styles.muted}`}>
                                    {format(value)}
                                  </td>
                                );
                              })}
                              <td className={styles.num}>{format(metricValue(bucket, metric))}</td>
                              <td className={`${styles.num} ${styles.muted}`}>
                                {formatCount(bucket.requests)}
                              </td>
                              <td
                                className={`${styles.num} ${bucket.failed > 0 ? styles.errorText : styles.muted}`}
                              >
                                {formatCount(bucket.failed)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}

          <footer className={styles.footnotes}>
            <p>
              {t('usage.cost_note', {
                source: summary.priceSource?.name || 'LiteLLM',
                date: summary.priceSource?.fetchedAt ?? '',
              })}
              {totals.unpricedRequests > 0 &&
                ` ${t('usage.unpriced_note', { count: totals.unpricedRequests })}`}
            </p>
            {coverage && <p>{coverage}</p>}
          </footer>
        </>
      )}

      <ModelDialog
        model={modelOpen}
        range={resolved}
        metric={metric}
        keyNames={keyNames}
        onClose={() => setModelOpen(null)}
      />
    </div>
  );
}

function BreakdownTable({
  groups,
  label,
  secondary,
  metric,
  grand,
  onOpen,
  nameHeader,
}: {
  groups: UsageGroup[];
  label: (group: UsageGroup) => string;
  secondary: (group: UsageGroup) => string | null;
  metric: Metric;
  grand: number;
  onOpen: (group: UsageGroup) => void;
  nameHeader: string;
}) {
  const { t } = useTranslation();
  const peak = Math.max(0, ...groups.map((group) => metricValue(group, metric)));
  if (groups.length === 0) return <div className={styles.chartEmpty}>{t('usage.empty_range')}</div>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.rank}>#</th>
            <th className={styles.nameCol}>{nameHeader}</th>
            <th className={styles.num}>{t('usage.col_requests')}</th>
            <th className={styles.num}>{t('usage.col_tokens')}</th>
            <th className={styles.num}>{t('usage.col_cost')}</th>
            <th className={`${styles.num} ${styles.hideNarrow}`}>{t('usage.col_share')}</th>
            <th className={`${styles.num} ${styles.hideNarrow}`}>{t('usage.col_errors')}</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => {
            const value = metricValue(group, metric);
            const sub = secondary(group);
            return (
              <tr key={group.id || index} className={styles.clickable}>
                <td className={`${styles.rank} ${styles.muted}`}>{index + 1}</td>
                <td className={styles.nameCol}>
                  <button type="button" className={styles.rowButton} onClick={() => onOpen(group)}>
                    <MiddleTruncate className={styles.rowName} value={label(group)} />
                  </button>
                  {sub && <span className={styles.rowSub}>{sub}</span>}
                  {value > 0 && peak > 0 && (
                    <div className={styles.rowBar} aria-hidden="true">
                      <div
                        style={{
                          width: `max(4px, ${(value / peak) * 100}%)`,
                          background: providerColor(group.provider),
                        }}
                      />
                    </div>
                  )}
                </td>
                <td className={styles.num}>{formatCount(group.requests)}</td>
                <td className={`${styles.num} ${styles.muted}`}>
                  {formatTokens(totalTokens(group))}
                </td>
                <td className={styles.num}>
                  {group.unpricedRequests > 0 && group.costUsd === 0 ? (
                    <span className={styles.muted}>{t('usage.unpriced')}</span>
                  ) : (
                    formatUsd(group.costUsd)
                  )}
                </td>
                <td className={`${styles.num} ${styles.muted} ${styles.hideNarrow}`}>
                  {formatPercent(grand > 0 ? value / grand : null)}
                </td>
                <td
                  className={`${styles.num} ${styles.hideNarrow} ${group.failed > 0 ? styles.errorText : styles.muted}`}
                >
                  {formatPercent(errorRate(group))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
