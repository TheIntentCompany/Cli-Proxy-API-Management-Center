/**
 * Pool: how much use is left across all accounts, counted in accounts. Six untouched
 * Claude accounts are "6 accounts' worth"; a Codex Pro 500 counts as 2.5 Pro 200s. Each
 * card says what is left, how many accounts take requests now and how long it lasts at
 * today's pace, then shows the history and projection, then every account's state in
 * words. Readings come from the usage collector, which reads every account every few
 * minutes, so nothing here needs a click to stay current.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { useNow } from '@/hooks/useNow';
import type { PoolAccount, PoolState, PoolWindowKind } from '@/services/api/usage';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import {
  bankedResets,
  burnPerHour,
  memberStatuses,
  poolNow,
  project,
  recordedSeries,
  type MemberStatus,
} from './model';
import { formatAccounts, formatDayTime, poolPlanLabel, weightNoteText } from './format';
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

  const statuses = memberStatuses(pool, now);
  const open = statuses.filter((status) => status.state === 'open').length;
  const banked = kind === 'fable' ? null : bankedResets(state.accounts, provider);
  const newest = Math.max(0, ...pool.members.map((member) => member.account.observedAtMs ?? 0));
  const oldest = Math.min(...pool.members.map((member) => member.account.observedAtMs ?? 0));
  const staleCount = pool.members.filter((member) => member.account.stale).length;
  const title =
    kind === 'fable' ? t('pool.card_fable') : provider === 'claude' ? 'Claude' : 'Codex';
  const accounts = (value: number) => formatAccounts(value, locale);
  const spending = rate !== null && rate >= 0.05;

  const lasts =
    rate === null
      ? t('pool.pace_unknown')
      : !spending
        ? t('pool.not_spending')
        : projection?.runsOutAt
          ? t('pool.lasts_until', { when: formatDayTime(projection.runsOutAt, locale) })
          : t('pool.lasts_past', { when: formatDayTime(now + AHEAD, locale) });

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
        <span className={styles.big}>{accounts(pool.remaining)}</span>
        <span className={styles.of}>
          {t(kind === 'fable' ? 'pool.left_fable' : 'pool.left_weekly', {
            count: pool.capacity / 100,
            capacity: accounts(pool.capacity),
          })}{' '}
          {weightNoteText(t, provider, pool)}
        </span>
      </div>
      <p className={styles.status}>
        <span className={open < pool.members.length ? styles.statusHeld : undefined}>
          {t(kind === 'fable' ? 'pool.fable_open' : 'pool.taking', {
            open,
            count: pool.members.length,
          })}
        </span>
        <span aria-hidden="true"> · </span>
        <span>{lasts}</span>
      </p>
      {(spending || !pool.weighted) && (
        <p className={styles.explain}>
          {!pool.weighted && t('pool.explain_unweighted')}
          {!pool.weighted && spending && ' '}
          {spending && t('pool.pace', { rate: accounts((rate as number) * 24) })}
        </p>
      )}

      <PoolChart
        recorded={recorded}
        projected={projection?.points ?? []}
        jumps={projection?.jumps ?? []}
        capacity={pool.capacity}
        from={now - PAST}
        to={now + AHEAD}
        now={now}
        color={COLORS[provider]}
        height={compact ? 200 : 240}
        locale={locale}
        nowLabel={t('pool.now')}
        ariaLabel={t('pool.chart_label', { name: title })}
        formatAccounts={accounts}
        describe={(value) => t('pool.chart_value', { value: accounts(value) })}
      />
      <p className={styles.caption}>
        {recorded.length === 0
          ? t('pool.no_history')
          : rate === null
            ? t('pool.caption_resets_only')
            : t('pool.caption')}
        {recorded.length > 0 && recorded[0].t > now - PAST + HOUR && (
          <> {t('pool.history_starts', { when: formatDayTime(recorded[0].t, locale) })}</>
        )}
      </p>

      <ul className={styles.list}>
        {statuses.map((status) => (
          <AccountLine
            key={status.member.account.key}
            status={status}
            provider={provider}
            kind={kind}
            now={now}
            showWeight={pool.weighted && pool.members.some((member) => member.weight !== 1)}
          />
        ))}
      </ul>

      {banked && banked.available !== null && (
        <p className={styles.banked}>
          {banked.available === 0
            ? t('pool.banked_none')
            : banked.soonestExpiryMs
              ? t('pool.banked', {
                  count: banked.available,
                  when: formatRelative(banked.soonestExpiryMs, now, locale),
                })
              : t('pool.banked_no_expiry', { count: banked.available })}
        </p>
      )}
    </section>
  );
}

/** One account in a pool card: name, plan weight where it matters, and its state in words. */
function AccountLine({
  status,
  provider,
  kind,
  now,
  showWeight,
}: {
  status: MemberStatus;
  provider: 'claude' | 'codex';
  kind: PoolWindowKind;
  now: number;
  showWeight: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { member } = status;
  const name = (account: PoolAccount) => account.label ?? account.fileName ?? account.key;
  const when = (ms: number) => formatRelative(ms, now, locale);
  const used = Math.round(member.usedPercent ?? 0);
  const left = Math.max(0, Math.min(100, 100 - used));

  let text: string;
  if (status.state === 'capped') {
    text = status.backAtMs
      ? t(kind === 'fable' ? 'pool.state_capped_fable' : 'pool.state_capped', {
          when: when(status.backAtMs),
        })
      : t('pool.state_capped_unknown');
  } else if (status.state === 'held') {
    text = status.backAtMs
      ? t(`pool.state_held_${status.heldBy}`, { when: when(status.backAtMs) })
      : t('pool.state_held_unknown');
  } else if (member.resetsAtMs === null) {
    text = t('pool.state_no_reset', { used });
  } else {
    text = t(used === 0 ? 'pool.state_unused' : 'pool.state_used', {
      used,
      when: when(member.resetsAtMs),
    });
  }
  const exact = status.backAtMs ?? member.resetsAtMs;

  return (
    <li className={status.state === 'open' ? undefined : styles.lineHeld}>
      <span className={styles.meter} aria-hidden="true">
        <span style={{ width: `${left}%` }} />
      </span>
      <MiddleTruncate className={styles.listName} value={name(member.account)} />
      {showWeight && member.account.plan ? (
        <span className={styles.muted}>
          {t('pool.plan_weight', {
            plan: poolPlanLabel(t, provider, member.account.plan),
            weight: member.weight,
          })}
        </span>
      ) : (
        <span />
      )}
      <span
        className={status.state === 'open' ? styles.state : styles.stateHeld}
        title={exact ? formatShortDateTime(exact, locale) : undefined}
      >
        {text}
      </span>
    </li>
  );
}
