/**
 * One account on the Limits page: identity, its 5-hour and weekly usage, any
 * model-specific weekly limits, and a single line of account facts.
 *
 * Before a usage read, the meters fall back to the rate-limit headers stored with the
 * account's latest served response, so the page is useful without clicking anything.
 * Actions (refresh, Claude banked resets, Codex reset and credit overage) reuse the
 * same hooks and dialogs as the card layout, so their safety checks are unchanged.
 */

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LimitMeter } from '@/components/ui/LimitMeter';
import { IconRefreshCw } from '@/components/ui/icons';
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
import { resolveCodexCreditOverageState } from '../providers/codex/creditOverage';
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
  const windows: WindowLike[] =
    status === 'success' || retainedClaude
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

  const windowName = (window: WindowLike) =>
    window.labelKey ? t(window.labelKey, window.labelParams) : window.label;

  const detail = (reading: LimitReading | null) => {
    if (!reading) return undefined;
    const parts: string[] = [];
    if (reading.resetAtMs) {
      parts.push(
        t('limits.resets', {
          when: formatRelative(reading.resetAtMs, now, locale),
          date: formatShortDateTime(reading.resetAtMs, locale),
        })
      );
    }
    return parts.join(' · ') || undefined;
  };

  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );

  /* ---------- the facts line ---------- */

  const facts: ReactNode[] = [];
  const planType = (claudeQuota?.planType ?? codexQuota?.planType ?? null) as string | null;
  if (planType && status === 'success') {
    facts.push(
      <span key="plan" className={styles.plan}>
        {family === 'claude'
          ? t(`claude_quota.${planType}`, { defaultValue: planType })
          : t(`codex_quota.plan_${planType}`, { defaultValue: planType })}
      </span>
    );
  }

  if (family === 'claude' && status === 'success') {
    const remaining = claudeReset.grants
      .filter((grant) => grant.resetsLeft > 0)
      .map((grant) => parseIsoToMs(grant.endsAt))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);
    if (claudeReset.count === null) {
      facts.push(<span key="resets">{t('limits.resets_loading')}</span>);
    } else if (claudeReset.count === 0) {
      facts.push(<span key="resets">{t('limits.no_resets')}</span>);
    } else {
      facts.push(
        <span key="resets">
          {t('limits.resets_available', { count: claudeReset.count })}
          {remaining.length > 0 && (
            <span className={styles.muted}>
              {' '}
              {t('limits.next_expiry', { when: formatShortDateTime(remaining[0], locale) })}
            </span>
          )}
        </span>
      );
    }
    const extra = claudeQuota?.extraUsage;
    if (extra) {
      const off = extra.isEnabled === false || extra.userDisabled === true;
      facts.push(<span key="extra">{off ? t('limits.extra_off') : t('limits.extra_on')}</span>);
    }
  }

  if (family === 'codex' && status === 'success') {
    const renewsAtMs = resolveResetMs([codexQuota?.subscriptionActiveUntil ?? null]);
    if (renewsAtMs !== null) {
      facts.push(
        <span key="renews">
          {t('limits.renews', { date: formatShortDateTime(renewsAtMs, locale) })}
        </span>
      );
    }
    if (codexQuota?.creditsUnlimited) {
      facts.push(<span key="credits">{t('limits.credits_unlimited')}</span>);
    } else if (codexQuota?.creditBalance) {
      facts.push(
        <span key="credits">{t('limits.credits', { value: codexQuota.creditBalance })}</span>
      );
    }
    const available = codexQuota?.rateLimitResetCreditsAvailableCount;
    if (typeof available === 'number') {
      const firstExpiry = (codexQuota?.rateLimitResetCredits ?? [])
        .map((credit) => parseIsoToMs(credit.expiresAt))
        .filter((ms): ms is number => ms !== null)
        .sort((a, b) => a - b)[0];
      facts.push(
        <span key="reset-credits">
          {t('limits.reset_credits', { count: available })}
          {firstExpiry !== undefined && (
            <span className={styles.muted}>
              {' '}
              {t('limits.next_expiry', { when: formatShortDateTime(firstExpiry, locale) })}
            </span>
          )}
        </span>
      );
    }
    if (codexQuota?.rateLimitResetCreditsError) {
      facts.push(
        <span key="reset-credits-error" className={styles.error}>
          {t('limits.reset_credits_failed')}
        </span>
      );
    }
    if (creditOverage.visible) {
      facts.push(
        <span key="overage">
          {t('limits.overage', {
            state: t(
              `codex_quota.credit_overage_state_${resolveCodexCreditOverageState(creditOverage.entry)}`
            ),
          })}{' '}
          <button
            type="button"
            className={styles.link}
            onClick={creditOverage.openDialog}
            disabled={creditOverage.blocked}
            aria-haspopup="dialog"
            aria-label={t('codex_quota.credit_overage_manage_aria', { name: title })}
          >
            {t('codex_quota.credit_overage_manage')}
          </button>
        </span>
      );
    }
  }

  const showCodexReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  const headerSeenAt = headers.weekly?.observedAtMs ?? headers.fiveHour?.observedAtMs ?? null;
  const statusNote =
    status === 'idle'
      ? headerSeenAt
        ? t('limits.from_headers', { when: formatRelative(headerSeenAt, now, locale) })
        : null
      : loading
        ? t('limits.reading')
        : status === 'error'
          ? t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })
          : claudeQuota?.stale && claudeQuota.observedAt
            ? t('limits.stale', {
                time: formatShortDateTime(Date.parse(claudeQuota.observedAt), locale),
              })
            : null;

  return (
    <li className={styles.row} aria-busy={loading || undefined}>
      <div className={styles.account}>
        <span className={styles.swatch} style={{ background: COLOR[family] }} aria-hidden="true" />
        <div className={styles.accountText}>
          <span className={styles.name} title={title}>
            {title}
          </span>
          <span className={styles.sub}>
            {t(`limits.family_${family}`)}
            {file.disabled ? ` · ${t('limits.disabled')}` : ''}
          </span>
        </div>
      </div>

      <LimitMeter
        label={t('limits.five_hour')}
        usedPercent={fiveHour?.usedPercent ?? null}
        color={COLOR[family]}
        detail={detail(fiveHour)}
        emptyText={t('limits.not_reported')}
        warningText={t('limits.near_limit')}
        labelHidden
      />
      <LimitMeter
        label={t('limits.weekly')}
        usedPercent={weekly?.usedPercent ?? null}
        color={COLOR[family]}
        detail={detail(weekly)}
        emptyText={t('limits.not_reported')}
        warningText={t('limits.near_limit')}
        labelHidden
      />
      <div className={styles.others}>
        {otherWindows.length === 0 ? (
          <span className={styles.none}>
            {status === 'success' ? t('limits.no_model_limits') : ''}
          </span>
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
          className={styles.readButton}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            className={loading ? styles.spinning : undefined}
            aria-hidden="true"
          />
          {status === 'idle' ? t('limits.read') : t('limits.refresh')}
        </button>
      </div>

      {(facts.length > 0 ||
        statusNote ||
        claudeReset.message ||
        family === 'claude' ||
        showCodexReset) && (
        <div className={styles.facts}>
          {statusNote && (
            <span
              className={status === 'error' ? styles.error : styles.muted}
              role={status === 'error' ? 'alert' : undefined}
            >
              {statusNote}
            </span>
          )}
          {facts.map((fact, index) => (
            <span key={index} className={styles.fact}>
              {fact}
            </span>
          ))}
          {family === 'claude' && status !== 'idle' && (
            <button
              type="button"
              className={styles.link}
              disabled={claudeReset.blocked}
              onClick={claudeReset.openDialog}
              aria-haspopup="dialog"
            >
              {t(`claude_reset.${claudeReset.buttonLabel}`)}
            </button>
          )}
          {showCodexReset && (
            <button
              type="button"
              className={styles.link}
              onClick={onReset}
              disabled={!canRefresh || loading || resetting}
            >
              {t('codex_quota.reset_button')}
            </button>
          )}
          {claudeReset.message && (
            <span role="status" className={styles.error}>
              {t(`claude_reset.${claudeReset.message}`)}
            </span>
          )}
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
