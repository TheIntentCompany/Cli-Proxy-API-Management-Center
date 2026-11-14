/**
 * An error as one plain sentence. When the provider returned a JSON body, the request id
 * shows as its own field and the body is offered through "Copy raw" instead of being
 * printed; other long text stays behind "Details".
 * Styled after T3 Code's alert (MIT, see THIRD_PARTY_NOTICES.md).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const described = describeError(error);
  const own = givenDetails !== undefined;
  const summary = own ? (error ?? '') : described.summary;
  const details = own ? givenDetails : described.details;
  const requestId = own ? null : described.requestId;
  const isJson = !own && described.isJson;
  const id = useId();
  const [copied, setCopied] = useState(false);

  const copyRaw = async () => {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={[styles.notice, styles[tone], className].filter(Boolean).join(' ')}
      role="alert"
      aria-describedby={details && !isJson ? id : undefined}
    >
      <span className={styles.dot} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.summary}>{summary}</p>
        {(requestId || (isJson && details)) && (
          <div className={styles.meta}>
            {requestId && (
              <span className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t('common.request_id', { defaultValue: 'Request ID' })}
                </span>
                <code title={requestId}>{requestId}</code>
              </span>
            )}
            {isJson && details && (
              <button type="button" className={styles.copy} onClick={() => void copyRaw()}>
                {copied
                  ? t('common.copied', { defaultValue: 'Copied' })
                  : t('common.copy_raw', { defaultValue: 'Copy raw' })}
              </button>
            )}
          </div>
        )}
        {details && !isJson && (
          <details className={styles.details}>
            <summary>{detailsLabel}</summary>
            <pre id={id}>{details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
