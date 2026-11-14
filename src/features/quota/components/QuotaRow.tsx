/**
 * One account on the Limits page. It carries everything the stock quota card had, in a
 * row: identity and plan, the 5-hour, weekly and model-specific windows, the account's
 * actions (Refresh quota, Claude's Reset limits, Codex's Reset quota and its credit
 * setting), and a details block with banked resets and their expiry dates, extra usage,
 * dollar balances, renewal time and credit balance.
 *
 * Before a usage read, the meters fall back to the rate-limit headers stored with the
 * account's latest served response. Actions reuse the stock hooks and dialogs, so their
 * safety checks are unchanged.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LimitMeter } from '@/components/ui/LimitMeter';
import { Badge, ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { IconHistory, IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { parseIsoToMs, resolveQuotaErrorMessage, resolveResetMs } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import { limitsFromHeaders, type LimitReading } from '@/features/dashboard/insights';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDialog } from '../providers/claude/ClaudeResetGrantDialog';
import { hasClaudeUsageData } from '../providers/claude/data';
import { CodexCreditOverageDialog } from '../providers/codex/CodexCreditOverageDialog';
import {
  formatCodexCreditOverageConfirmedAt,
  resolveCodexCreditOverageState,
} from '../providers/codex/creditOverage';
import { codexPlanLabel } from '../providers/codex/planLabel';
import { useCodexCreditOverage } from '../providers/codex/useCodexCreditOverage';
import styles from './QuotaRow.module.scss';

type WindowLike = {
  id: string;
  label: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent: number | null;
  resetAtMs?: number | null;
};

export interface QuotaRowProps {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  canRefresh: boolean;
  resetting: boolean;
  /** Codex only: credentials sharing this account user's credit setting. */
  creditOverageSharedCount?: number;
  onRefresh: () => void;
  onReset: () => void;
}

const COLOR = {
  claude: 'var(--viz-claude)',
  codex: 'var(--viz-codex)',
} as const;

const WEEKLY_ID = { claude: 'seven-day', codex: 'weekly' } as const;

/** "out_of_credits" -> "Out of credits", for provider codes without a translation. */
const plainWords = (code: string) => {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) + '.' : code;
};

/** One labelled fact in the details block. */
function Fact({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  /** Spans two columns, for lists whose labels need room. */
  wide?: boolean;
}) {
  return (
    <div className={wide ? `${styles.fact} ${styles.factWide}` : styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function QuotaRow({
  entry,
  quota,
  canRefresh,
  resetting,
  creditOverageSharedCount = 1,
  onRefresh,
  onReset,
}: QuotaRowProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const family = entry.type === 'codex' ? 'codex' : 'claude';
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const name = getQuotaDisplayName(file);
  const label = typeof file.label === 'string' && file.label.trim() ? file.label.trim() : '';
  const email = typeof file.email === 'string' ? file.email.trim() : '';
  const title = label || email || name;
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';

  const claudeQuota = family === 'claude' ? (quota as ClaudeQuotaState | undefined) : undefined;
  const codexQuota = family === 'codex' ? (quota as CodexQuotaState | undefined) : undefined;
  // Claude keeps showing its last good reading while a refresh runs or after it fails.
  const retainedClaude = family === 'claude' && hasClaudeUsageData(claudeQuota);
  const hasReading = status === 'success' || retainedClaude;
  const windows: WindowLike[] = hasReading
    ? ((quota as { windows?: WindowLike[] })?.windows ?? [])
    : [];

  const claudeReset = useClaudeResetGrants(
    file,
    family === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const creditOverage = useCodexCreditOverage(
    file,
    codexQuota,
    !canRefresh || loading || resetting
  );

  const headers = limitsFromHeaders(file);
  const fromWindow = (window: WindowLike | undefined): LimitReading | null =>
    window && window.usedPercent !== null
      ? {
          usedPercent: window.usedPercent,
          resetAtMs: window.resetAtMs ?? null,
          source: 'usage',
          observedAtMs: null,
        }
      : null;
  const fiveHourWindow = windows.find((window) => window.id === 'five-hour');
  const weeklyWindow = windows.find((window) => window.id === WEEKLY_ID[family]);
  const fiveHour = fromWindow(fiveHourWindow) ?? headers.fiveHour;
  const weekly = fromWindow(weeklyWindow) ?? headers.weekly;
  const otherWindows = windows.filter(
    (window) => window !== fiveHourWindow && window !== weeklyWindow
  );

  // Relative first ("in 26 days"), with the date beside it for planning.
  const when = (ms: number) =>
    `${formatRelative(ms, now, locale)} · ${formatShortDateTime(ms, locale)}`;
  const windowName = (window: WindowLike) =>
    window.labelKey ? t(window.labelKey, window.labelParams) : window.label;
  const meterDetail = (reading: LimitReading | null) =>
    reading?.resetAtMs
      ? t('limits.resets', {
          when: formatRelative(reading.resetAtMs, now, locale),
          date: formatShortDateTime(reading.resetAtMs, locale),
        })
      : undefined;

  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  const planLabel =
    family === 'codex'
      ? codexPlanLabel(t, codexQuota?.planType)
      : claudeQuota?.planType
        ? t(`claude_quota.${claudeQuota.planType}`, { defaultValue: claudeQuota.planType })
        : null;

  const headerSeenAt = headers.weekly?.observedAtMs ?? headers.fiveHour?.observedAtMs ?? null;
  const statusLine = loading
    ? t('limits.reading')
    : status === 'idle' && headerSeenAt
      ? t('limits.from_headers', { when: formatRelative(headerSeenAt, now, locale) })
      : claudeQuota?.stale && claudeQuota.observedAt
        ? t('limits.stale', {
            time: formatShortDateTime(Date.parse(claudeQuota.observedAt), locale),
          })
        : null;

  /* ---------- details: everything the stock card body showed ---------- */

  const facts: ReactNode[] = [];

  if (family === 'claude' && status === 'success') {
    const grants = claudeReset.grants
      .filter((grant) => grant.resetsLeft > 0)
      .sort((a, b) => (parseIsoToMs(a.endsAt) ?? Infinity) - (parseIsoToMs(b.endsAt) ?? Infinity));
    facts.push(
      <Fact key="resets" label={t('claude_reset.title')} wide>
        {claudeReset.count !== null && claudeReset.count > 0 && (
          <span>
            {t('claude_reset.remaining')}: {claudeReset.count}
          </span>
        )}
        {claudeReset.count === null ? (
          <span className={styles.muted}>{t('limits.resets_loading')}</span>
        ) : grants.length === 0 ? (
          <span className={styles.muted}>{t('claude_reset.empty')}</span>
        ) : (
          <ul className={styles.list}>
            {grants.map((grant, index) => {
              const ends = parseIsoToMs(grant.endsAt);
              return (
                <li key={grant.id}>
                  <span className={styles.listLabel} title={grant.label || undefined}>
                    {grant.label || t('claude_reset.grant_number', { index: index + 1 })}
                  </span>
                  {/* "1 of 1" on every line repeats itself; only multi-use grants say it. */}
                  {grant.resetsTotal > 1 && (
                    <span className={styles.listValue}>
                      {t('limits.grant_left', { left: grant.resetsLeft, total: grant.resetsTotal })}
                    </span>
                  )}
                  <span className={styles.listWhen}>
                    {ends ? when(ends) : t('claude_reset.expiry_unknown')}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Fact>
    );

    const extra = claudeQuota?.extraUsage;
    if (extra) {
      const off =
        extra.isEnabled === false ||
        extra.userDisabled === true ||
        extra.disabledReason === 'user_disabled';
      const money = (value: number | null) => {
        if (value === null) return '--';
        try {
          return new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: extra.currency ?? 'USD',
          }).format(value / 100);
        } catch {
          return `${(value / 100).toFixed(2)} ${extra.currency ?? 'USD'}`;
        }
      };
      facts.push(
        <Fact key="extra" label={t('claude_quota.extra_usage_label')}>
          <span className={styles.inline}>
            <Badge variant={off ? 'neutral' : 'success'}>
              {t(
                off
                  ? 'claude_quota.extra_usage_disabled'
                  : extra.isEnabled === true
                    ? 'claude_quota.extra_usage_enabled'
                    : 'claude_quota.plan_unknown'
              )}
            </Badge>
            {(extra.usedCredits !== null || extra.monthlyLimit !== null) && (
              <span>
                {extra.monthlyLimit === null
                  ? t('limits.spent_no_limit', { spent: money(extra.usedCredits ?? 0) })
                  : t('limits.spent_of_limit', {
                      spent: money(extra.usedCredits ?? 0),
                      limit: money(extra.monthlyLimit),
                    })}
              </span>
            )}
            {extra.utilization !== null && (
              <span className={styles.muted}>
                {t('claude_quota.usage_utilization', { percent: extra.utilization })}
              </span>
            )}
          </span>
          {extra.spendLimitReached && (
            <span className={styles.note}>{t('claude_quota.extra_usage_spend_limit_reached')}</span>
          )}
          {extra.disabledReason && extra.disabledReason !== 'user_disabled' && (
            <span className={styles.note}>
              {t(`limits.reason_${extra.disabledReason}`, {
                defaultValue: plainWords(extra.disabledReason),
              })}
            </span>
          )}
        </Fact>
      );
    }

    for (const balance of claudeQuota?.dollarWindows ?? []) {
      const dollars = (value: number | null) =>
        value === null
          ? '--'
          : new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value);
      const resetMs = resolveResetMs([balance.resetsAt]);
      facts.push(
        <Fact key={`balance-${balance.key}`} label={balance.key}>
          <span>
            {t('claude_quota.dollar_balance_remaining', {
              amount: dollars(balance.remainingDollars),
            })}
          </span>
          {(balance.usedDollars !== null || balance.limitDollars !== null) && (
            <span className={styles.muted}>
              {balance.limitDollars === null
                ? t('limits.spent_no_limit', { spent: dollars(balance.usedDollars ?? 0) })
                : t('limits.spent_of_limit', {
                    spent: dollars(balance.usedDollars ?? 0),
                    limit: dollars(balance.limitDollars),
                  })}
            </span>
          )}
          <span className={styles.muted}>
            {resetMs
              ? `${t('claude_quota.balance_reset')} ${when(resetMs)}`
              : t('claude_quota.balance_reset_unknown')}
          </span>
        </Fact>
      );
    }
  }

  if (family === 'codex' && status === 'success') {
    const renewsAtMs = resolveResetMs([codexQuota?.subscriptionActiveUntil ?? null]);
    if (renewsAtMs !== null) {
      facts.push(
        <Fact key="renews" label={t('codex_quota.expires_label')}>
          {when(renewsAtMs)}
        </Fact>
      );
    }
    if (codexQuota?.creditsUnlimited || codexQuota?.creditBalance != null) {
      facts.push(
        <Fact key="credits" label={t('codex_quota.credit_balance_label')}>
          {codexQuota?.creditsUnlimited
            ? t('codex_quota.credit_unlimited')
            : String(codexQuota?.creditBalance)}
        </Fact>
      );
    }
    const available = codexQuota?.rateLimitResetCreditsAvailableCount;
    const credits = codexQuota?.rateLimitResetCredits ?? [];
    if (
      typeof available === 'number' ||
      credits.length > 0 ||
      codexQuota?.rateLimitResetCreditsError
    ) {
      facts.push(
        <Fact key="reset-credits" label={t('codex_quota.reset_credits_label')}>
          {typeof available === 'number' && <span>{available}</span>}
          {credits.length > 0 && (
            <ul className={styles.list}>
              {credits.map((credit, index) => {
                const expires = parseIsoToMs(credit.expiresAt);
                return (
                  <li key={credit.id || index}>
                    <span className={styles.listLabel}>
                      {t('codex_quota.reset_credit_number', { index: index + 1 })}
                    </span>
                    <span className={styles.listWhen}>
                      {expires ? when(expires) : credit.expiresAt}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {codexQuota?.rateLimitResetCreditsError && (
            <span className={styles.note}>
              {t('codex_quota.reset_credits_expiry_failed', {
                message: codexQuota.rateLimitResetCreditsError,
              })}
            </span>
          )}
        </Fact>
      );
    }
    if (creditOverage.visible) {
      const state = resolveCodexCreditOverageState(creditOverage.entry);
      facts.push(
        <Fact key="overage" label={t('codex_quota.credit_overage_label')}>
          <span className={styles.inline}>
            <span>{t(`codex_quota.credit_overage_state_${state}`)}</span>
            {creditOverage.entry?.status === 'known' && (
              <span className={styles.muted}>
                {t('codex_quota.credit_overage_confirmed_at', {
                  time: formatCodexCreditOverageConfirmedAt(creditOverage.entry.at),
                })}
              </span>
            )}
            <button
              type="button"
              className={styles.linkButton}
              onClick={creditOverage.openDialog}
              disabled={creditOverage.blocked}
              aria-haspopup="dialog"
              aria-label={t('codex_quota.credit_overage_manage_aria', { name: title })}
            >
              {t('codex_quota.credit_overage_manage')}
            </button>
          </span>
        </Fact>
      );
    }
  }

  const showCodexReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <li className={styles.row} aria-busy={loading || undefined}>
      <div className={styles.account}>
        <span className={styles.swatch} style={{ background: COLOR[family] }} aria-hidden="true" />
        <div className={styles.accountText}>
          <MiddleTruncate className={styles.name} value={title} />
          <span className={styles.sub}>
            <span>{t(`limits.family_${family}`)}</span>
            {planLabel && <Badge variant="outline">{planLabel}</Badge>}
            {file.disabled && <Badge>{t('limits.disabled')}</Badge>}
          </span>
          {statusLine && <span className={styles.status}>{statusLine}</span>}
        </div>
      </div>

      <div className={`${styles.meter} ${styles.meterFive}`}>
        <LimitMeter
          label={t('limits.five_hour')}
          usedPercent={fiveHour?.usedPercent ?? null}
          color={COLOR[family]}
          detail={meterDetail(fiveHour)}
          emptyText={t('limits.not_reported')}
          warningText={t('limits.near_limit')}
          labelHidden
        />
      </div>
      <div className={`${styles.meter} ${styles.meterWeek}`}>
        <LimitMeter
          label={t('limits.weekly')}
          usedPercent={weekly?.usedPercent ?? null}
          color={COLOR[family]}
          detail={meterDetail(weekly)}
          emptyText={t('limits.not_reported')}
          warningText={t('limits.near_limit')}
          labelHidden
        />
      </div>
      <div className={styles.others}>
        {otherWindows.length === 0 ? (
          <span className={styles.none}>{hasReading ? t('limits.no_model_limits') : ''}</span>
        ) : (
          otherWindows.map((window) => (
            <LimitMeter
              key={window.id}
              label={windowName(window)}
              usedPercent={window.usedPercent}
              color={COLOR[family]}
              detail={
                window.resetAtMs
                  ? t('limits.resets_short', {
                      when: formatRelative(window.resetAtMs, now, locale),
                    })
                  : undefined
              }
              emptyText={t('limits.not_reported')}
              warningText={t('limits.near_limit')}
            />
          ))
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            className={loading ? styles.spinning : undefined}
            aria-hidden="true"
          />
          {t('auth_files.quota_refresh_single')}
        </button>
        {family === 'claude' && (
          <button
            type="button"
            className={styles.resetAction}
            disabled={status === 'idle' || claudeReset.blocked}
            onClick={claudeReset.openDialog}
            aria-haspopup="dialog"
            title={t('limits.reset_hint')}
          >
            <IconHistory
              size={13}
              className={claudeReset.busy ? styles.pulsing : undefined}
              aria-hidden="true"
            />
            {claudeReset.buttonLabel === 'retry'
              ? t('claude_reset.retry')
              : t('limits.reset_action')}
          </button>
        )}
        {showCodexReset && (
          <button
            type="button"
            className={styles.resetAction}
            onClick={onReset}
            disabled={!canRefresh || loading || resetting}
            aria-haspopup="dialog"
            title={t('limits.reset_hint')}
          >
            <IconHistory
              size={13}
              className={resetting ? styles.pulsing : undefined}
              aria-hidden="true"
            />
            {t('limits.reset_action')}
          </button>
        )}
      </div>

      {(facts.length > 0 || status === 'error' || claudeReset.message) && (
        <div className={styles.details}>
          {status === 'error' && (
            <ErrorNotice
              error={t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
              detailsLabel={t('common.details', { defaultValue: 'Details' })}
            />
          )}
          {claudeReset.message && (
            <ErrorNotice
              tone="warning"
              error={t(`claude_reset.${claudeReset.message}`)}
              detailsLabel={t('common.details', { defaultValue: 'Details' })}
            />
          )}
          {facts.length > 0 && <dl className={styles.facts}>{facts}</dl>}
        </div>
      )}

      {family === 'claude' && (
        <ClaudeResetGrantDialog
          open={claudeReset.open}
          grants={claudeReset.grants}
          selected={claudeReset.selected}
          canRedeemGrant={claudeReset.canRedeemGrant}
          onSelect={claudeReset.selectGrant}
          busy={claudeReset.busy}
          loading={claudeReset.loading}
          pendingGrantId={claudeReset.pendingGrantId}
          message={claudeReset.message}
          name={name}
          onConfirm={() => void claudeReset.confirm()}
          onClose={claudeReset.closeDialog}
        />
      )}
      {creditOverage.context && (
        <CodexCreditOverageDialog
          open={creditOverage.open}
          context={creditOverage.context}
          entry={creditOverage.entry}
          operation={creditOverage.operation}
          writeDisabled={creditOverage.writeDisabled}
          contextCurrent={creditOverage.contextCurrent}
          sharedCredentialCount={creditOverageSharedCount}
          selection={creditOverage.selection}
          pendingTarget={creditOverage.pendingTarget}
          feedback={creditOverage.feedback}
          onSelect={creditOverage.selectValue}
          onSave={() => void creditOverage.save()}
          onClose={creditOverage.closeDialog}
        />
      )}
    </li>
  );
}
