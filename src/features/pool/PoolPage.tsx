/**
 * Pool: every account's limits added together, per provider. Six Claude accounts with
 * nothing used show 600%. Each card answers how much room is left, how fast it is going,
 * when it runs out, what the next resets bring back, which accounts are limited now and
 * how many banked resets are on hand. Readings come from the usage collector, which reads
 * every account every few minutes, so nothing here needs a click to stay current.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { useNow } from '@/hooks/useNow';
import type { PoolAccount, PoolState, PoolWindowKind } from '@/services/api/usage';
import { codexPlanLabel } from '@/features/quota/providers/codex/planLabel';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import {
  bankedResets,
  burnPerHour,
  limitedAccounts,
  poolNow,
  project,
  recordedSeries,
  upcomingResets,
  weightNotes,
} from './model';
import { PoolChart } from './PoolChart';
import { usePool } from './usePool';
import styles from './pool.module.scss';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAST = 5 * DAY;
const AHEAD = 5 * DAY;

const COLORS = { claude: 'var(--viz-claude)', codex: 'var(--viz-codex)' } as const;
const ICONS = { claude: iconClaude, codex: iconCodex } as const;

export function PoolPage() {
  const { t } = useTranslation();
  const now = useNow();
  // Re-anchor the history range each hour; the minute clock moves "now" in between.
  const anchor = Math.floor(now / HOUR) * HOUR;
  const range = useMemo(() => ({ from: anchor - PAST, to: anchor + HOUR }), [anchor]);
  const { state, error } = usePool(range);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>{t('pool.title')}</h1>
        <p>{t('pool.subtitle')}</p>
      </header>

      {error && (
        <ErrorNotice
          error={state ? t('usage.stale_error') : t('pool.unreachable')}
          details={error}
          detailsLabel={t('common.details', { defaultValue: 'Details' })}
        />
      )}
      {!state && !error && <div className={styles.loading}>{t('common.loading')}</div>}

      {state && (
        <div className={styles.cards}>
          <PoolCard state={state} provider="claude" kind="weekly" now={now} />
          <PoolCard state={state} provider="codex" kind="weekly" now={now} />
          <PoolCard state={state} provider="claude" kind="fable" now={now} compact />
        </div>
      )}
    </div>
  );
}

function PoolCard({
  state,
  provider,
  kind,
  now,
  compact = false,
}: {
  state: PoolState;
  provider: 'claude' | 'codex';
  kind: PoolWindowKind;
  now: number;
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const pool = useMemo(
    () => poolNow(state.accounts, provider, kind, now),
    [state, provider, kind, now]
  );
  const session = useMemo(
    () => poolNow(state.accounts, provider, 'five_hour', now),
    [state, provider, now]
  );
  const recorded = useMemo(
    () => recordedSeries(pool, state.history, now - PAST, now),
    [pool, state.history, now]
  );
  const rate = burnPerHour(recorded, now);
  const projection = useMemo(
    () => (pool.members.length > 0 ? project(pool, rate ?? 0, now, AHEAD) : null),
    [pool, rate, now]
  );
  if (pool.members.length === 0) return null;

  const limited = limitedAccounts(state.accounts, provider, now);
  // A reset that brings nothing back (an untouched account) is not worth a line.
  const resets = upcomingResets(pool)
    .filter((reset) => reset.restores >= 0.5)
    .slice(0, 5);
  const banked = bankedResets(state.accounts, provider);
  const notes = weightNotes(pool);
  const newest = Math.max(0, ...pool.members.map((member) => member.account.observedAtMs ?? 0));
  const oldest = Math.min(...pool.members.map((member) => member.account.observedAtMs ?? 0));
  const staleCount = pool.members.filter((member) => member.account.stale).length;
  const when = (ms: number) =>
    `${formatRelative(ms, now, locale)} · ${formatShortDateTime(ms, locale)}`;
  const name = (account: PoolAccount) => account.label ?? account.fileName ?? account.key;
  const title =
    kind === 'fable' ? t('pool.card_fable') : provider === 'claude' ? 'Claude' : 'Codex';
  const planLabel = (plan: string) =>
    provider === 'codex' ? (codexPlanLabel(t, plan) ?? plan) : plan;

  return (
    <section className={`${styles.card} ${compact ? styles.cardCompact : ''}`}>
      <header className={styles.cardHead}>
        <span className={styles.cardTitle}>
          <img src={ICONS[provider]} alt="" width={18} height={18} />
          <strong>{title}</strong>
          <span className={styles.muted}>{t('pool.accounts', { count: pool.members.length })}</span>
        </span>
        <span className={styles.updated} title={formatShortDateTime(oldest || newest, locale)}>
          {newest > 0 ? t('pool.updated', { when: formatRelative(newest, now, locale) }) : ''}
          {staleCount > 0 && ` · ${t('pool.stale_count', { count: staleCount })}`}
        </span>
      </header>

      <div className={styles.headline}>
        <span className={styles.big}>{Math.round(pool.remaining)}%</span>
        <span className={styles.of}>
          {t(kind === 'fable' ? 'pool.of_fable' : 'pool.of_weekly', {
            capacity: Math.round(pool.capacity),
          })}
        </span>
        {notes.map((note) => (
          <Badge key={note.plan} variant="outline">
            {t('pool.weight_note', { plan: planLabel(note.plan), weight: note.weight })}
          </Badge>
        ))}
      </div>
      <p className={styles.explain}>
        {pool.weighted
          ? provider === 'claude'
            ? t('pool.explain_claude')
            : t('pool.explain_codex')
          : t('pool.explain_unweighted')}
      </p>

      <PoolChart
        recorded={recorded}
        projected={projection?.points ?? []}
        jumps={projection?.jumps ?? []}
        capacity={pool.capacity}
        from={now - PAST}
        to={now + AHEAD}
        now={now}
        color={COLORS[provider]}
        height={compact ? 200 : 260}
        locale={locale}
        nowLabel={t('pool.now')}
        ariaLabel={t('pool.chart_label', { name: title })}
      />
      <div className={styles.legend}>
        <span>
          <i className={styles.legendSolid} style={{ background: COLORS[provider] }} />
          {t('pool.recorded')}
        </span>
        <span>
          <i className={styles.legendDashed} style={{ borderColor: COLORS[provider] }} />
          {t('pool.projected')}
        </span>
        {recorded.length === 0 && <span className={styles.muted}>{t('pool.no_history')}</span>}
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>{t('pool.runs_out')}</dt>
          <dd>
            {rate === null
              ? t('pool.rate_unknown')
              : rate < 0.05
                ? t('pool.not_spending')
                : projection?.runsOutAt
                  ? when(projection.runsOutAt)
                  : t('pool.lasts', { days: AHEAD / DAY })}
          </dd>
          <dd className={styles.hint}>
            {rate !== null && rate >= 0.05
              ? t('pool.burn', { rate: Math.round(rate * 24) })
              : t('pool.burn_hint')}
          </dd>
        </div>

        <div>
          <dt>{t('pool.next_resets')}</dt>
          {resets.length === 0 ? (
            <dd className={styles.muted}>{t('pool.no_resets')}</dd>
          ) : (
            <dd>
              <ul className={styles.list}>
                {resets.map((reset) => (
                  <li key={reset.member.account.key}>
                    <MiddleTruncate
                      className={styles.listName}
                      value={name(reset.member.account)}
                    />
                    <span className={styles.muted}>{formatRelative(reset.at, now, locale)}</span>
                    <span>+{Math.round(reset.restores)}%</span>
                  </li>
                ))}
              </ul>
            </dd>
          )}
        </div>

        {kind !== 'fable' && (
          <div>
            <dt>{t('pool.limited_now')}</dt>
            {limited.length === 0 ? (
              <dd className={styles.muted}>{t('pool.none_limited')}</dd>
            ) : (
              <dd>
                <ul className={styles.list}>
                  {limited.map((entry) => (
                    <li key={entry.account.key}>
                      <MiddleTruncate className={styles.listName} value={name(entry.account)} />
                      <span className={styles.warning}>
                        {entry.reopensAtMs
                          ? t('pool.reopens', {
                              when: formatRelative(entry.reopensAtMs, now, locale),
                            })
                          : t('pool.limited')}
                      </span>
                    </li>
                  ))}
                </ul>
              </dd>
            )}
            <dd className={styles.hint}>{t('pool.limited_hint')}</dd>
          </div>
        )}

        {kind !== 'fable' && session.members.length > 0 && (
          <div>
            <dt>{t('pool.five_hour')}</dt>
            <dd>
              {t('pool.five_hour_value', {
                remaining: Math.round(session.remaining),
                capacity: Math.round(session.capacity),
              })}
            </dd>
            <dd className={styles.hint}>{t('pool.five_hour_hint')}</dd>
          </div>
        )}

        {kind !== 'fable' && (
          <div>
            <dt>{t('pool.banked')}</dt>
            <dd>
              {banked.available === null
                ? t('pool.banked_unknown')
                : t('pool.banked_value', { count: banked.available })}
            </dd>
            <dd className={styles.hint}>
              {banked.soonestExpiryMs
                ? t('pool.banked_expiry', { when: when(banked.soonestExpiryMs) })
                : t('pool.banked_hint')}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
