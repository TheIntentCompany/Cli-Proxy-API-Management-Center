import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore, useQuotaStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useCodexLbStatus } from '@/hooks/useCodexLbStatus';
import { LimitMeter } from '@/components/ui/LimitMeter';
import { formatCompactNumber } from '@/utils/format';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { useDashboardOverview } from './hooks/useDashboardOverview';
import { LineChart, type LineSeries } from './components/LineChart';
import {
  BUCKETS_PER_WINDOW,
  RANGE_OPTIONS,
  bucketEndsMinutesAgo,
  buildAccountRows,
  buildApiKeyRows,
  withoutApiKeyDuplicates,
  claudeCodexSplit,
  combineBuckets,
  seriesByFamily,
  successRateSeries,
  sumBuckets,
  type AccountRow,
  type LimitReading,
  type ProviderFamily,
} from './insights';
import styles from './dashboard.module.scss';

type Metric = 'requests' | 'success';

const FAMILY_COLOR: Record<ProviderFamily, string> = {
  claude: 'var(--viz-claude)',
  codex: 'var(--viz-codex)',
  other: 'var(--viz-other)',
};

const DASH = '–';

const formatCount = (value: number): string =>
  value < 10_000 ? Math.round(value).toLocaleString() : formatCompactNumber(value);

const formatShare = (value: number): string => `${value.toFixed(1)}%`;

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  // Minute clock: relative labels stay current without re-rendering every frame.
  const now = useNow();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const { connected, config, authFiles, authFilesLoadedAt, usageByProvider, refresh } =
    useDashboardOverview();
  const { status: codexLbStatus } = useCodexLbStatus();
  const { batchLoading, loadQuota } = useQuotaBatchLoader();

  useHeaderRefresh(refresh, connected);

  const [metric, setMetric] = useState<Metric>('requests');
  const [rangeId, setRangeId] = useState('all');
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<ProviderFamily>>(new Set());
  const [hiddenAccounts, setHiddenAccounts] = useState<Set<string>>(new Set());

  const range = RANGE_OPTIONS.find((option) => option.id === rangeId) ?? RANGE_OPTIONS[2];
  const familyName = (family: ProviderFamily) => t(`insights.family_${family}`);

  // OAuth credentials plus API-key credentials; an API key that reaches a codex-lb
  // account is named after that account.
  const rows = useMemo(
    () => [
      ...buildAccountRows(withoutApiKeyDuplicates(authFiles ?? [], usageByProvider), {
        claude: claudeQuota,
        codex: codexQuota,
      }),
      ...buildApiKeyRows(usageByProvider, codexLbStatus, {
        viaCodexLb: (accounts) => t('insights.via_codex_lb', { accounts }),
        apiKey: (masked) => t('insights.api_key', { key: masked }),
      }),
    ],
    [authFiles, usageByProvider, codexLbStatus, claudeQuota, codexQuota, t]
  );

  const familiesPresent = useMemo(
    () =>
      (['claude', 'codex', 'other'] as ProviderFamily[]).filter((f) =>
        rows.some((r) => r.family === f)
      ),
    [rows]
  );

  const visibleRows = useMemo(
    () => rows.filter((row) => !hiddenFamilies.has(row.family) && !hiddenAccounts.has(row.key)),
    [rows, hiddenFamilies, hiddenAccounts]
  );

  const familySeries = useMemo(
    () => seriesByFamily(visibleRows, range.buckets),
    [visibleRows, range]
  );
  const allFamilySeries = useMemo(() => seriesByFamily(rows, range.buckets), [rows, range]);
  const combined = useMemo(() => combineBuckets(visibleRows, range.buckets), [visibleRows, range]);
  const totals = sumBuckets(combined);
  const requests = totals.success + totals.failed;
  const successRate = requests > 0 ? (totals.success / requests) * 100 : null;
  const split = claudeCodexSplit(familySeries);
  const grandTotal = allFamilySeries.reduce((sum, item) => sum + item.total, 0);

  const count = range.buckets;
  const xLabel = (index: number) => {
    const ago = bucketEndsMinutesAgo(index, count);
    return ago === 0 ? t('insights.now') : formatRelative(now - ago * 60_000, now, locale);
  };
  const xTicks = useMemo(() => {
    const step = count <= 6 ? 1 : count <= 12 ? 3 : 6;
    const ticks: number[] = [];
    for (let index = count - 1; index >= 0; index -= step) ticks.unshift(index);
    if (ticks[0] !== 0 && ticks[0] > step / 2) ticks.unshift(0);
    else if (ticks[0] !== 0) ticks[0] = 0;
    return ticks;
  }, [count]);

  const chartSeries: LineSeries[] =
    metric === 'requests'
      ? familySeries.map((item) => ({
          id: item.family,
          label: familyName(item.family),
          color: FAMILY_COLOR[item.family],
          values: item.values,
          // No fill: one translucent area per series hid Claude under Codex.
          area: false,
        }))
      : [
          {
            id: 'success',
            label: t('insights.success_rate'),
            color: 'var(--viz-codex)',
            values: successRateSeries(combined),
          },
        ];

  const failureMarkers =
    metric === 'success'
      ? combined
          .map((bucket, index) => ({ bucket, index }))
          .filter(({ bucket }) => bucket.failed > 0)
          .map(({ index }) => ({ index, seriesId: 'success' }))
      : [];

  const limitRows = useMemo(
    () =>
      visibleRows
        .filter((row) => row.family !== 'other')
        .sort(
          (a, b) => (b.limits.weekly?.usedPercent ?? -1) - (a.limits.weekly?.usedPercent ?? -1)
        ),
    [visibleRows]
  );

  const servedRows = useMemo(
    () =>
      visibleRows
        .map((row) => ({ row, window: sumBuckets(row.buckets.slice(-range.buckets)) }))
        .sort(
          (a, b) =>
            b.window.success + b.window.failed - (a.window.success + a.window.failed) ||
            b.row.sinceStart.success - a.row.sinceStart.success
        ),
    [visibleRows, range]
  );
  const servedPeak = Math.max(1, ...servedRows.map(({ window }) => window.success + window.failed));

  const readLimits = () => {
    if (!authFiles) return;
    const targets = classifyQuotaFiles(authFiles).filter(
      (entry) => entry.type === 'claude' || entry.type === 'codex'
    );
    void loadQuota(targets);
  };

  const toggleFamily = (family: ProviderFamily) =>
    setHiddenFamilies((current) => {
      const next = new Set(current);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  const toggleAccount = (key: string) =>
    setHiddenAccounts((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const limitDetail = (reading: LimitReading | null): string => {
    if (!reading) return '';
    const parts: string[] = [];
    if (reading.resetAtMs) {
      parts.push(t('insights.resets', { when: formatRelative(reading.resetAtMs, now, locale) }));
    }
    return parts.join(' · ');
  };

  const lead = split.leadPoints;
  const routing = config?.routingStrategy?.trim() || DASH;

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{t('insights.title')}</h1>
            <span className={styles.titleMeta}>
              {t('insights.source', { version: serverVersion?.trim() || DASH })}
            </span>
            <span className={styles.updated}>
              {authFilesLoadedAt
                ? t('insights.updated', { time: formatShortDateTime(authFilesLoadedAt, locale) })
                : t('insights.loading')}
            </span>
          </div>
          <div className={styles.tabs} role="toolbar" aria-label={t('insights.view_controls')}>
            <div className={styles.tabGroup} role="group" aria-label={t('insights.metric')}>
              {(['requests', 'success'] as Metric[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.tab} ${metric === id ? styles.tabActive : ''}`}
                  aria-pressed={metric === id}
                  onClick={() => setMetric(id)}
                >
                  {t(id === 'requests' ? 'insights.metric_requests' : 'insights.metric_success')}
                </button>
              ))}
            </div>
            <span className={styles.tabDivider} aria-hidden="true" />
            <div className={styles.tabGroup} role="group" aria-label={t('insights.range')}>
              {RANGE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.tab} ${rangeId === option.id ? styles.tabActive : ''}`}
                  aria-pressed={rangeId === option.id}
                  onClick={() => setRangeId(option.id)}
                >
                  {t(`insights.range_${option.id}`)}
                </button>
              ))}
            </div>
          </div>
        </header>

        {metric === 'requests' && split.claudeShare !== null && split.codexShare !== null ? (
          <section className={styles.headline} aria-label={t('insights.share_title')}>
            <div className={styles.side}>
              <span className={styles.sideName}>
                <span className={styles.swatch} style={{ background: FAMILY_COLOR.claude }} />
                {familyName('claude')}
              </span>
              <span className={`${styles.hero} ${styles.heroClaude}`}>
                {formatShare(split.claudeShare)}
              </span>
            </div>
            <div className={styles.lead}>
              {/* The share covers the whole range; the chart's end labels are the last bucket. */}
              <span className={styles.leadMeta}>{t(`insights.share_range_${range.id}`)}</span>
              <span className={styles.leadValue}>
                {lead === 0 ? '0' : `+${Math.abs(lead ?? 0).toFixed(1)}`}
                <span className={styles.leadUnit}>pp</span>
              </span>
              <span className={styles.leadMeta}>
                {lead === 0
                  ? t('insights.even')
                  : t('insights.leads', { name: familyName((lead ?? 0) > 0 ? 'claude' : 'codex') })}
              </span>
            </div>
            <div className={`${styles.side} ${styles.sideRight}`}>
              <span className={styles.sideName}>
                <span className={styles.swatch} style={{ background: FAMILY_COLOR.codex }} />
                {familyName('codex')}
              </span>
              <span className={styles.hero}>{formatShare(split.codexShare)}</span>
            </div>
          </section>
        ) : (
          <section className={styles.headline}>
            <div className={styles.side}>
              <span className={styles.sideName}>
                {metric === 'requests' ? t('insights.requests') : t('insights.success_rate')}
              </span>
              <span className={styles.hero}>
                {metric === 'requests'
                  ? formatCount(requests)
                  : successRate === null
                    ? DASH
                    : formatShare(successRate)}
              </span>
            </div>
            <div className={styles.lead}>
              <span className={styles.leadMeta}>{t(`insights.range_${range.id}_long`)}</span>
            </div>
            <div className={`${styles.side} ${styles.sideRight}`}>
              <span className={styles.sideName}>
                {metric === 'requests' ? t('insights.success_rate') : t('insights.failed')}
              </span>
              <span className={styles.hero}>
                {metric === 'requests'
                  ? successRate === null
                    ? DASH
                    : formatShare(successRate)
                  : formatCount(totals.failed)}
              </span>
            </div>
          </section>
        )}

        <div className={styles.chart}>
          {visibleRows.length === 0 ? (
            <p className={styles.empty}>
              {authFiles === null ? t('insights.loading') : t('insights.nothing_selected')}
            </p>
          ) : (
            <LineChart
              series={chartSeries}
              ariaLabel={
                metric === 'requests' ? t('insights.chart_requests') : t('insights.chart_success')
              }
              xLabel={xLabel}
              xTicks={xTicks}
              yFormat={(value) =>
                metric === 'success' ? `${Math.round(value)}%` : formatCount(value)
              }
              valueFormat={(value) =>
                metric === 'success' ? formatShare(value) : formatCount(value)
              }
              yMax={metric === 'success' ? 100 : undefined}
              markers={failureMarkers}
              extraRows={(index) =>
                metric === 'success'
                  ? [
                      {
                        label: t('insights.requests'),
                        value: formatCount(combined[index].success + combined[index].failed),
                      },
                      { label: t('insights.failed'), value: formatCount(combined[index].failed) },
                    ]
                  : []
              }
            />
          )}
        </div>
        <p className={styles.footnote}>
          {metric === 'requests' ? t('insights.footnote_requests') : t('insights.footnote_success')}
        </p>

        <section className={styles.stats} aria-label={t('insights.stats')}>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('insights.requests')}</span>
            <span className={styles.statValue}>{formatCount(requests)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('insights.success_rate')}</span>
            <span className={styles.statValue}>
              {successRate === null ? DASH : formatShare(successRate)}
            </span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('insights.failed')}</span>
            <span className={styles.statValue}>{formatCount(totals.failed)}</span>
          </div>
          <div className={styles.stat}>
            <span className={styles.statLabel}>{t('insights.accounts_serving')}</span>
            <span className={styles.statValue}>
              {
                visibleRows.filter(
                  (row) => sumBuckets(row.buckets.slice(-range.buckets)).success > 0
                ).length
              }
              <span className={styles.statOf}>
                {' '}
                {t('insights.of_total', { total: visibleRows.length })}
              </span>
            </span>
          </div>
        </section>

        <div className={styles.columns}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t('insights.limits_title')}</h2>
              <button
                type="button"
                className={styles.textButton}
                onClick={readLimits}
                disabled={batchLoading || !authFiles}
              >
                {batchLoading ? t('insights.reading') : t('insights.read_limits')}
              </button>
            </div>
            <p className={styles.panelNote}>{t('insights.limits_note')}</p>
            {limitRows.length === 0 ? (
              <p className={styles.empty}>{t('insights.no_limits')}</p>
            ) : (
              <ul className={styles.limitList}>
                {limitRows.map((row) => (
                  <li key={row.key} className={styles.limitRow}>
                    <AccountName row={row} />
                    <LimitMeter
                      label={t('insights.five_hour')}
                      usedPercent={row.limits.fiveHour?.usedPercent ?? null}
                      color={FAMILY_COLOR[row.family]}
                      detail={limitDetail(row.limits.fiveHour)}
                      emptyText={t('insights.not_reported')}
                      warningText={t('insights.near_limit')}
                    />
                    <LimitMeter
                      label={t('insights.weekly')}
                      usedPercent={row.limits.weekly?.usedPercent ?? null}
                      color={FAMILY_COLOR[row.family]}
                      detail={limitDetail(row.limits.weekly)}
                      emptyText={t('insights.not_reported')}
                      warningText={t('insights.near_limit')}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t('insights.served_title')}</h2>
            </div>
            <p className={styles.panelNote}>
              {t('insights.served_note', { range: t(`insights.range_${range.id}_long`) })}
            </p>
            <ul className={styles.servedList}>
              {servedRows.map(({ row, window }) => {
                const total = window.success + window.failed;
                return (
                  <li key={row.key} className={styles.servedRow}>
                    <AccountName row={row} />
                    <div
                      className={styles.servedBar}
                      role="img"
                      aria-label={t('insights.served_aria', {
                        name: row.name,
                        success: window.success,
                        failed: window.failed,
                      })}
                    >
                      {window.success > 0 && (
                        <span
                          className={styles.servedFill}
                          style={{
                            width: `${(window.success / servedPeak) * 100}%`,
                            background: FAMILY_COLOR[row.family],
                          }}
                        />
                      )}
                      {window.failed > 0 && (
                        <span
                          className={styles.servedFill}
                          style={{
                            width: `${(window.failed / servedPeak) * 100}%`,
                            background: 'var(--viz-failure)',
                          }}
                        />
                      )}
                    </div>
                    <span className={styles.servedValue}>
                      {formatCount(total)}
                      {window.failed > 0 && (
                        <span className={styles.servedFailed}>
                          {t('insights.failed_count', { count: window.failed })}
                        </span>
                      )}
                    </span>
                    <span className={styles.servedSince}>
                      {t('insights.since_start', {
                        count: row.sinceStart.success + row.sinceStart.failed,
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <section className={styles.gateway} aria-label={t('insights.gateway')}>
          <dl className={styles.facts}>
            <div>
              <dt>{t('insights.fact_version')}</dt>
              <dd>{serverVersion?.trim() || DASH}</dd>
            </div>
            <div>
              <dt>{t('insights.fact_routing')}</dt>
              <dd>{routing}</dd>
            </div>
            <div>
              <dt>{t('insights.fact_retry')}</dt>
              <dd>{String(config?.requestRetry ?? DASH)}</dd>
            </div>
            <div>
              <dt>{t('insights.fact_file_logs')}</dt>
              <dd>{config?.loggingToFile ? t('insights.on') : t('insights.off')}</dd>
            </div>
          </dl>
          <nav className={styles.links} aria-label={t('insights.shortcuts')}>
            <Link to="/auth-files">{t('insights.link_accounts')}</Link>
            <Link to="/oauth">{t('insights.link_sign_in')}</Link>
            <Link to="/ai-providers">{t('insights.link_api_keys')}</Link>
            <Link to="/quota">{t('insights.link_limits')}</Link>
          </nav>
        </section>
      </div>

      <aside className={styles.sidebar} aria-label={t('insights.filters')}>
        <div className={styles.sideHead}>
          <h2 className={styles.sideTitle}>
            {t('insights.providers')}
            <span className={styles.sideCount}>{familiesPresent.length}</span>
          </h2>
          <button
            type="button"
            className={styles.resetButton}
            onClick={() => {
              setHiddenFamilies(new Set());
              setHiddenAccounts(new Set());
            }}
            aria-label={t('insights.reset_filters')}
            title={t('insights.reset_filters')}
          >
            ↺
          </button>
        </div>
        <ul className={styles.checkList}>
          {familiesPresent.map((family) => {
            const total = allFamilySeries.find((item) => item.family === family)?.total ?? 0;
            return (
              <li key={family}>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={!hiddenFamilies.has(family)}
                    onChange={() => toggleFamily(family)}
                  />
                  <span className={styles.swatch} style={{ background: FAMILY_COLOR[family] }} />
                  <span className={styles.checkName}>{familyName(family)}</span>
                  <span className={styles.checkValue}>
                    {grandTotal > 0 ? formatShare((total / grandTotal) * 100) : DASH}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <div className={styles.sideHead}>
          <h2 className={styles.sideTitle}>
            {t('insights.accounts')}
            <span className={styles.sideCount}>{rows.length}</span>
          </h2>
          <div className={styles.sideActions}>
            <button type="button" onClick={() => setHiddenAccounts(new Set())}>
              {t('insights.select_all')}
            </button>
            <button
              type="button"
              onClick={() => setHiddenAccounts(new Set(rows.map((row) => row.key)))}
            >
              {t('insights.clear')}
            </button>
          </div>
        </div>
        <ul className={styles.checkList}>
          {rows.map((row) => {
            const window = sumBuckets(row.buckets.slice(-range.buckets));
            return (
              <li key={row.key}>
                <label
                  className={`${styles.check} ${hiddenFamilies.has(row.family) ? styles.checkMuted : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={!hiddenAccounts.has(row.key)}
                    onChange={() => toggleAccount(row.key)}
                  />
                  <span
                    className={styles.swatch}
                    style={{ background: FAMILY_COLOR[row.family] }}
                  />
                  <span className={styles.checkName} title={row.name}>
                    {row.name}
                  </span>
                  <span className={styles.checkValue}>
                    {formatCount(window.success + window.failed)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        <details className={styles.method}>
          <summary>{t('insights.method_title')}</summary>
          <p>{t('insights.method_buckets', { count: BUCKETS_PER_WINDOW })}</p>
          <p>{t('insights.method_limits')}</p>
          <p>{t('insights.method_missing')}</p>
        </details>
      </aside>
    </div>
  );
}

function AccountName({ row }: { row: AccountRow }) {
  const { t } = useTranslation();
  return (
    <span className={styles.accountName}>
      <span className={styles.swatch} style={{ background: FAMILY_COLOR[row.family] }} />
      <span className={styles.accountText} title={row.name}>
        {row.name}
      </span>
      {row.disabled && <span className={styles.accountFlag}>{t('insights.disabled')}</span>}
      {!row.disabled && row.unavailable && (
        <span className={styles.accountFlag}>{t('insights.cooling_down')}</span>
      )}
    </span>
  );
}
