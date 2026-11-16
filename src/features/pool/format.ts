/**
 * Pool wording shared by the Pool page and the Accounts summary. The pool is counted in
 * accounts: 100 pool percent is one untouched account (one Pro 200 for Codex), so a pool
 * value of 270 reads "2.7 accounts' worth".
 */
import type { TFunction } from 'i18next';
import { codexPlanLabel } from '@/features/quota/providers/codex/planLabel';
import { type PoolNow, weightNotes } from './model';

/** "2.7" for 270 pool percent, to one decimal and without a trailing ".0". */
export function formatAccounts(poolPercent: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    Math.round(poolPercent / 10) / 10
  );
}

/** "Thu 08:47" in the viewer's zone. */
export function formatDayTime(ms: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/** Display name for a plan in this provider's pool, such as "Pro 500". */
export function poolPlanLabel(t: TFunction, provider: 'claude' | 'codex', plan: string): string {
  return provider === 'codex' ? (codexPlanLabel(t, plan) ?? plan) : plan;
}

/** "(Pro 500 counts 2.5x)" for each plan that does not count as one account. */
export function weightNoteText(t: TFunction, provider: 'claude' | 'codex', pool: PoolNow) {
  return weightNotes(pool)
    .map((note) =>
      t('pool.weight_note', { plan: poolPlanLabel(t, provider, note.plan), weight: note.weight })
    )
    .join(' ');
}
