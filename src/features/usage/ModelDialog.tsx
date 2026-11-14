/**
 * One model over the chosen range: its use over time, where its tokens went, how it
 * performed, and which accounts and client keys used it. After T3 Code's UsageModelDialog.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { cacheHitRate, errorRate, totalTokens, type UsageGroup } from '@/services/api/usage';
import { LineChart } from '@/features/dashboard/components/LineChart';
import { formatCount, formatMs, formatPercent, formatTokens, formatUsd } from './format';
import { useUsageSummary } from './hooks';
import { bucketLabel, evenTicks, providerColor, providerName } from './chart';
import { Stat } from './Stat';
import type { ResolvedRange } from './range';
import { ShareBar } from './ShareBar';
import styles from './usage.module.scss';

type Metric = 'tokens' | 'cost' | 'requests';

export function ModelDialog({
  model,
  range,
  metric,
  keyNames,
  onClose,
}: {
  model: string | null;
  range: ResolvedRange;
  metric: Metric;
  keyNames: Record<string, string>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const filters = useMemo(
    () => (model ? { from: range.from, to: range.to, model } : null),
    [model, range.from, range.to]
  );
  const { summary, error } = useUsageSummary(filters, range.bucket);
  const totals = summary?.totals;
  const provider = summary?.byModel[0]?.provider ?? null;
  const format = (value: number) =>
    metric === 'tokens'
      ? formatTokens(value)
      : metric === 'cost'
        ? formatUsd(value)
        : formatCount(value);
  const pick = (
    bucket: { requests: number; costUsd: number } & Parameters<typeof totalTokens>[0]
  ) =>
    metric === 'tokens'
      ? totalTokens(bucket)
      : metric === 'cost'
        ? bucket.costUsd
        : bucket.requests;

  const list = (groups: UsageGroup[] | undefined, label: (group: UsageGroup) => string) => (
    <ul className={styles.miniList}>
      {[...(groups ?? [])]
        .sort((a, b) => pick(b) - pick(a))
        .slice(0, 8)
        .map((group) => (
          <li key={group.id}>
            <MiddleTruncate className={styles.rowName} value={label(group)} />
            <span className={styles.muted}>{formatCount(group.requests)}</span>
            <span>{format(pick(group))}</span>
          </li>
        ))}
    </ul>
  );

  return (
    <Modal open={model !== null} onClose={onClose} width={760} title={model ?? ''}>
      {error && <ErrorNotice error={t('usage.collector_unreachable')} details={error} />}
      {!summary && !error && <div className={styles.loading}>{t('common.loading')}</div>}
      {summary && totals && (
        <div className={styles.dialogBody}>
          <p className={styles.muted}>
            {providerName(provider, t('usage.unknown'))} ·{' '}
            {t('usage.model_dialog_meta', {
              requests: formatCount(totals.requests),
              tokens: formatTokens(totalTokens(totals)),
              cost: formatUsd(totals.costUsd),
            })}
          </p>
          <LineChart
            series={[
              {
                id: model ?? 'model',
                label: t(`usage.metric_${metric}`),
                color: providerColor(provider),
                values: summary.series.map(pick),
              },
            ]}
            ariaLabel={t(`usage.chart_${metric}_${range.bucket}`)}
            xLabel={(index) =>
              bucketLabel(summary.series[index]?.t ?? 0, range.bucket, i18n.resolvedLanguage)
            }
            xTicks={evenTicks(summary.series.length, 5)}
            yFormat={format}
            valueFormat={format}
            endValue={() => format(pick(totals))}
            height={200}
          />
          <ShareBar
            label={t('usage.tokens_by_type')}
            format={formatTokens}
            segments={[
              {
                label: t('usage.token_uncached'),
                value: totals.inputUncached,
                color: 'var(--viz-codex)',
              },
              {
                label: t('usage.token_cache_read'),
                value: totals.cacheRead,
                color: 'color-mix(in srgb, var(--viz-codex) 45%, transparent)',
              },
              {
                label: t('usage.token_cache_write'),
                value: totals.cacheWrite,
                color: 'var(--viz-claude)',
              },
              { label: t('usage.token_output'), value: totals.output, color: 'var(--t3-primary)' },
            ]}
          />
          <div className={styles.stats}>
            <Stat label={t('usage.stat_errors')} value={formatPercent(errorRate(totals))} />
            <Stat label={t('usage.stat_cache')} value={formatPercent(cacheHitRate(totals))} />
            <Stat label={t('usage.stat_p50')} value={formatMs(totals.latencyP50Ms)} />
            <Stat label={t('usage.stat_ttft')} value={formatMs(totals.ttftP50Ms)} />
          </div>
          <div className={styles.dialogColumns}>
            <div>
              <h3 className={styles.sectionTitle}>{t('usage.breakdown_account')}</h3>
              {list(summary.byAccount, (group) => group.label)}
            </div>
            <div>
              <h3 className={styles.sectionTitle}>{t('usage.breakdown_key')}</h3>
              {list(summary.byKey, (group) => keyNames[group.id] ?? group.label)}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
