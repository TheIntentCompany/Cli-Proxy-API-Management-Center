/**
 * A Codex account that CLIProxyAPI reaches through codex-lb rather than holding itself.
 * It reads like a QuotaRow, and its actions are codex-lb's own: Refresh quota runs
 * codex-lb's probe, Reset spends one banked reset through codex-lb's consume endpoint.
 * Both go through the actions relay (deploy/codex-lb-actions), so codex-lb remains the
 * only thing that holds or uses the account's token.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LimitMeter } from '@/components/ui/LimitMeter';
import { Badge, ErrorNotice, MiddleTruncate } from '@/components/ui/t3';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { useNotificationStore } from '@/stores';
import {
  codexLbAccountName,
  codexLbActionsApi,
  type CodexLbAccount,
  type CodexLbKey,
  type CodexLbResets,
  type CodexLbWindow,
} from '@/services/api/codexLb';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import styles from './QuotaRow.module.scss';

const COLOR = 'var(--viz-codex)';
const BLOCKED_STATUSES = new Set(['rate_limited', 'quota_exceeded', 'usage_limited', 'blocked']);

const newRedeemId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function CodexLbRow({
  account,
  keyInfo,
  onChanged,
}: {
  account: CodexLbAccount;
  keyInfo: CodexLbKey;
  /** Called after an action so the caller can re-read the status service. */
  onChanged?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const name = codexLbAccountName(account);
  const five = account.windows.find((window) => window.kind === 'five_hour') ?? null;
  const weekly = account.windows.find((window) => window.kind === 'weekly') ?? null;
  // Free plans carry a monthly quota instead of the 5-hour and weekly ones.
  const monthly = account.windows.find((window) => window.kind === 'monthly') ?? null;

  const [resets, setResets] = useState<CodexLbResets | null>(null);
  const [resetsError, setResetsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'refresh' | 'reset' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadResets = useCallback(async () => {
    try {
      setResets(await codexLbActionsApi.resets(account.id));
      setResetsError(null);
    } catch (error) {
      setResetsError(error instanceof Error ? error.message : String(error));
    }
  }, [account.id]);

  useEffect(() => {
    void loadResets();
  }, [loadResets]);

  const available = resets?.available ?? account.resetCreditsAvailable ?? null;

  const run = async (kind: 'refresh' | 'reset', action: () => Promise<unknown>) => {
    setBusy(kind);
    setActionError(null);
    try {
      await action();
      showNotification(
        t(kind === 'refresh' ? 'codex_lb.refreshed' : 'codex_lb.reset_done', { name }),
        'success'
      );
      onChanged?.();
      void loadResets();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const refresh = () => void run('refresh', () => codexLbActionsApi.refresh(account.id));
  const reset = () =>
    showConfirmation({
      title: t('codex_lb.reset_confirm_title'),
      message: t('codex_lb.reset_confirm_message', { name }),
      confirmText: t('codex_lb.reset_confirm_button'),
      variant: 'primary',
      onConfirm: () => run('reset', () => codexLbActionsApi.reset(account.id, newRedeemId())),
    });

  const meterDetail = (window: CodexLbWindow | null) =>
    window?.resetAtMs
      ? t('limits.resets', {
          when: formatRelative(window.resetAtMs, now, locale),
          date: formatShortDateTime(window.resetAtMs, locale),
        })
      : undefined;
  const when = (ms: number) =>
    `${formatShortDateTime(ms, locale)} (${formatRelative(ms, now, locale)})`;

  const status = account.status ?? 'unknown';
  const blocked = BLOCKED_STATUSES.has(status);
  const statusText = t(`codex_lb.status_${status}`, { defaultValue: status.replace(/_/g, ' ') });
  const recordedAt = Math.max(0, ...account.windows.map((window) => window.recordedAtMs ?? 0));
  const credits = (resets?.credits ?? [])
    .filter((credit) => !credit.status || !/redeemed|used|expired/i.test(credit.status))
    .sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity));

  return (
    <li className={styles.row} aria-busy={busy !== null || undefined}>
      <div className={styles.account}>
        <span className={styles.swatch} style={{ background: COLOR }} aria-hidden="true" />
        <div className={styles.accountText}>
          <MiddleTruncate className={styles.name} value={name} />
          <span className={styles.sub}>
            <span>{t('codex_lb.via')}</span>
            {account.planType && (
              <Badge variant="outline">
                {t(`codex_quota.plan_${account.planType}`, { defaultValue: account.planType })}
              </Badge>
            )}
            <Badge variant={blocked ? 'warning' : status === 'active' ? 'success' : 'neutral'}>
              {statusText}
            </Badge>
          </span>
          {recordedAt > 0 && (
            <span className={styles.status}>
              {t('codex_lb.updated', { when: formatRelative(recordedAt, now, locale) })}
            </span>
          )}
        </div>
      </div>

      <div className={`${styles.meter} ${styles.meterFive}`}>
        <LimitMeter
          label={t('limits.five_hour')}
          usedPercent={five?.usedPercent ?? null}
          color={COLOR}
          detail={meterDetail(five)}
          emptyText={t('limits.not_reported')}
          warningText={t('limits.near_limit')}
          labelHidden
        />
      </div>
      <div className={`${styles.meter} ${styles.meterWeek}`}>
        <LimitMeter
          label={t('limits.weekly')}
          usedPercent={weekly?.usedPercent ?? null}
          color={COLOR}
          detail={meterDetail(weekly)}
          emptyText={t('limits.not_reported')}
          warningText={t('limits.near_limit')}
          labelHidden
        />
      </div>
      <div className={styles.others}>
        {monthly ? (
          <LimitMeter
            label={t('codex_lb.monthly')}
            usedPercent={monthly.usedPercent}
            color={COLOR}
            detail={meterDetail(monthly)}
            emptyText={t('limits.not_reported')}
            warningText={t('limits.near_limit')}
          />
        ) : (
          <span className={styles.none}>{t('limits.no_model_limits')}</span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={refresh}
          disabled={busy !== null}
          title={t('codex_lb.refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            className={busy === 'refresh' ? styles.spinning : undefined}
            aria-hidden="true"
          />
          {t('auth_files.quota_refresh_single')}
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={reset}
          disabled={busy !== null || !available}
          title={t('codex_lb.reset_hint')}
          aria-haspopup="dialog"
        >
          <IconRefreshCw
            size={13}
            className={busy === 'reset' ? styles.spinning : undefined}
            aria-hidden="true"
          />
          {available ? t('codex_lb.reset_count', { count: available }) : t('codex_lb.reset')}
        </button>
      </div>

      <div className={styles.details}>
        {actionError && (
          <ErrorNotice
            error={actionError}
            detailsLabel={t('common.details', { defaultValue: 'Details' })}
          />
        )}
        <dl className={styles.facts}>
          <Fact label={t('codex_lb.status_label')}>
            <span>
              {blocked && account.blockedUntilMs
                ? t('codex_lb.status_until', {
                    status: statusText,
                    date: when(account.blockedUntilMs),
                  })
                : statusText}
            </span>
            {account.statusReason && <span className={styles.muted}>{account.statusReason}</span>}
          </Fact>
          <Fact label={t('codex_quota.reset_credits_label')}>
            <span>
              {available === null ? t('codex_lb.resets_unknown') : available}
              {resets && resets.unusable > 0 && (
                <span className={styles.muted}>
                  {' '}
                  · {t('codex_lb.resets_unusable', { count: resets.unusable })}
                </span>
              )}
            </span>
            {credits.length > 0 && (
              <ul className={styles.list}>
                {credits.map((credit, index) => (
                  <li key={`${credit.expiresAtMs ?? 'x'}-${index}`}>
                    <span className={styles.listLabel} title={credit.title ?? undefined}>
                      {credit.title || t('codex_quota.reset_credit_number', { index: index + 1 })}
                    </span>
                    <span className={styles.listWhen}>
                      {credit.expiresAtMs
                        ? when(credit.expiresAtMs)
                        : t('claude_reset.expiry_unknown')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {resetsError && (
              <span className={styles.muted}>{t('codex_lb.resets_dates_unavailable')}</span>
            )}
          </Fact>
          <Fact label={t('codex_lb.key_label')}>
            <span>{keyInfo.name}</span>
            {!keyInfo.active && <span className={styles.error}>{t('codex_lb.key_inactive')}</span>}
          </Fact>
        </dl>
      </div>
    </li>
  );
}
