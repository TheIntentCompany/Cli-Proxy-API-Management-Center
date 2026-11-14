/**
 * An error as one plain sentence, with the provider's original text behind "Details".
 * Styled after T3 Code's alert (MIT, see THIRD_PARTY_NOTICES.md).
 */
import { useId } from 'react';
import { describeError } from '@/utils/describeError';
import styles from './ErrorNotice.module.scss';

export function ErrorNotice({
  error,
  details: givenDetails,
  tone = 'error',
  detailsLabel = 'Details',
  className,
}: {
  error: string | null | undefined;
  /** The original text, when the caller already wrote the plain sentence itself. */
  details?: string;
  tone?: 'error' | 'warning';
  detailsLabel?: string;
  className?: string;
}) {
  const described = describeError(error);
  const summary = givenDetails === undefined ? described.summary : (error ?? '');
  const details = givenDetails === undefined ? described.details : givenDetails;
  const id = useId();
  return (
    <div
      className={[styles.notice, styles[tone], className].filter(Boolean).join(' ')}
      role="alert"
      aria-describedby={details ? id : undefined}
    >
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.summary}>{summary}</p>
        {details && (
          <details className={styles.details}>
            <summary>{detailsLabel}</summary>
            <pre id={id}>{details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
