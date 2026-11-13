import type { ReactNode } from 'react';
import styles from './LimitMeter.module.scss';

/** At or above this share of a limit, the meter adds a written warning. */
export const LIMIT_WARNING_PERCENT = 90;

interface LimitMeterProps {
  label: string;
  /** 0 to 100, or null when the provider has not reported this window. */
  usedPercent: number | null;
  /** Fill color; identity of the provider, not severity. */
  color: string;
  /** Right-hand detail, usually the reset time. */
  detail?: ReactNode;
  emptyText: string;
  warningText: string;
  /** Keep the label for assistive tech only, when a column heading already names it. */
  labelHidden?: boolean;
}

/**
 * One limit window as a hairline track with a thin fill. Severity is written out
 * ("near limit") instead of being carried by color alone.
 */
export function LimitMeter({
  label,
  usedPercent,
  color,
  detail,
  emptyText,
  warningText,
  labelHidden = false,
}: LimitMeterProps) {
  const known = usedPercent !== null && Number.isFinite(usedPercent);
  const value = known ? Math.min(100, Math.max(0, usedPercent as number)) : 0;
  const warn = known && value >= LIMIT_WARNING_PERCENT;
  return (
    <div className={styles.meter}>
      <div className={styles.head}>
        <span className={labelHidden ? styles.srOnly : styles.label}>{label}</span>
        <span className={styles.value}>
          {known ? `${Math.round(value)}%` : <span className={styles.empty}>{emptyText}</span>}
          {warn && <span className={styles.warn}>{warningText}</span>}
        </span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? Math.round(value) : undefined}
        aria-valuetext={known ? `${Math.round(value)}%` : emptyText}
      >
        {known && value > 0 && (
          <div className={styles.fill} style={{ width: `${value}%`, background: color }} />
        )}
      </div>
      {detail && <div className={styles.detail}>{detail}</div>}
    </div>
  );
}
