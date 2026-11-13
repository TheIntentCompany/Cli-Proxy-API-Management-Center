/**
 * A Codex account that CLIProxyAPI reaches through codex-lb rather than holding
 * itself. It reads like a QuotaRow but is read-only: codex-lb owns the account, so
 * refresh, reset and sign-in actions live there, not in this panel.
 */
import { useTranslation } from 'react-i18next';
import { LimitMeter } from '@/components/ui/LimitMeter';
import { useNow } from '@/hooks/useNow';
import type { CodexLbAccount, CodexLbKey, CodexLbWindow } from '@/services/api/codexLb';
import { codexLbAccountName } from '@/services/api/codexLb';
import { formatRelative, formatShortDateTime } from '@/utils/relativeTime';
import styles from './QuotaRow.module.scss';

const COLOR = 'var(--viz-codex)';
const BLOCKED_STATUSES = new Set(['rate_limited', 'quota_exceeded', 'usage_limited', 'blocked']);

export function CodexLbRow({ account, keyInfo }: { account: CodexLbAccount; keyInfo: CodexLbKey }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const name = codexLbAccountName(account);
  const five = account.windows.find((window) => window.kind === 'five_hour') ?? null;
  const weekly = account.windows.find((window) => window.kind === 'weekly') ?? null;
  // Free plans carry a monthly quota instead of the 5-hour and weekly ones.
  const monthly = account.windows.find((window) => window.kind === 'monthly') ?? null;

  const detail = (window: CodexLbWindow | null) =>
    window?.resetAtMs
      ? t('limits.resets', {
          when: formatRelative(window.resetAtMs, now, locale),
          date: formatShortDateTime(window.resetAtMs, locale),
        })
      : undefined;

  const status = account.status ?? 'unknown';
  const blocked = BLOCKED_STATUSES.has(status);
  const statusText = t(`codex_lb.status_${status}`, { defaultValue: status.replace(/_/g, ' ') });
  const recordedAt = Math.max(0, ...account.windows.map((window) => window.recordedAtMs ?? 0));

  return (
    <li className={styles.row}>
      <div className={styles.account}>
        <span className={styles.swatch} style={{ background: COLOR }} aria-hidden="true" />
        <div className={styles.accountText}>
          <span className={styles.name} title={name}>
            {name}
          </span>
          <span className={styles.sub}>{t('codex_lb.via')}</span>
        </div>
      </div>
      <LimitMeter
        label={t('limits.five_hour')}
        usedPercent={five?.usedPercent ?? null}
        color={COLOR}
        detail={detail(five)}
        emptyText={t('limits.not_reported')}
        warningText={t('limits.near_limit')}
        labelHidden
      />
      <LimitMeter
        label={t('limits.weekly')}
        usedPercent={weekly?.usedPercent ?? null}
        color={COLOR}
        detail={detail(weekly)}
        emptyText={t('limits.not_reported')}
        warningText={t('limits.near_limit')}
        labelHidden
      />
      <div className={styles.others}>
        {monthly ? (
          <LimitMeter
            label={t('codex_lb.monthly')}
            usedPercent={monthly.usedPercent}
            color={COLOR}
            detail={detail(monthly)}
            emptyText={t('limits.not_reported')}
            warningText={t('limits.near_limit')}
          />
        ) : (
          <span className={styles.none}>{t('limits.no_model_limits')}</span>
        )}
      </div>
      <div className={styles.actions} />
      <div className={styles.facts}>
        {account.planType && (
          <span className={`${styles.fact} ${styles.plan}`}>
            {t(`codex_quota.plan_${account.planType}`, { defaultValue: account.planType })}
          </span>
        )}
        <span className={`${styles.fact} ${blocked ? styles.error : ''}`}>
          {blocked && account.blockedUntilMs
            ? t('codex_lb.status_until', {
                status: statusText,
                date: formatShortDateTime(account.blockedUntilMs, locale),
              })
            : statusText}
          {account.statusReason ? ` (${account.statusReason})` : ''}
        </span>
        <span className={styles.fact}>{t('codex_lb.key', { name: keyInfo.name })}</span>
        {!keyInfo.active && (
          <span className={`${styles.fact} ${styles.error}`}>{t('codex_lb.key_inactive')}</span>
        )}
        {recordedAt > 0 && (
          <span className={`${styles.fact} ${styles.muted}`}>
            {t('codex_lb.updated', { when: formatRelative(recordedAt, now, locale) })}
          </span>
        )}
      </div>
    </li>
  );
}
