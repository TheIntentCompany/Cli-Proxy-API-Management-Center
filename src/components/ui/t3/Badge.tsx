/** T3 Code's badge (MIT, see THIRD_PARTY_NOTICES.md): an 18px label for state and counts. */
import type { ComponentProps } from 'react';
import styles from './Badge.module.scss';

export type BadgeVariant = 'neutral' | 'outline' | 'success' | 'warning' | 'error' | 'info';

export function Badge({
  variant = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { variant?: BadgeVariant }) {
  return (
    <span
      className={[styles.badge, styles[variant], className].filter(Boolean).join(' ')}
      {...props}
    />
  );
}
