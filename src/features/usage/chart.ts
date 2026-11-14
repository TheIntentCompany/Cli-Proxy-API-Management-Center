import { providerLabel } from '@/features/dashboard/utils';

const PROVIDER_COLORS: Record<string, string> = {
  claude: 'var(--viz-claude)',
  codex: 'var(--viz-codex)',
};

export const providerColor = (provider: string | null | undefined) =>
  PROVIDER_COLORS[provider ?? ''] ?? 'var(--t3-muted-foreground)';

export const providerName = (provider: string | null | undefined, unknown: string) =>
  providerLabel(provider ?? '', unknown);

/** Bucket label: "14:00" for hours, "Nov 12" for days. */
export const bucketLabel = (ms: number, bucket: 'hour' | 'day', locale?: string) =>
  bucket === 'hour'
    ? new Date(ms).toLocaleTimeString(locale, { hour: 'numeric' })
    : new Date(ms).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

/** About six evenly spaced ticks, always including the last bucket. */
export const evenTicks = (count: number, target = 6): number[] => {
  if (count <= 0) return [];
  if (count <= target) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / (target - 1));
  const ticks: number[] = [];
  for (let index = 0; index < count; index += step) ticks.push(index);
  const last = count - 1;
  // Keep the final bucket labelled without crowding the tick before it.
  if (ticks[ticks.length - 1] !== last) {
    if (last - ticks[ticks.length - 1] < step * 0.6) ticks.pop();
    ticks.push(last);
  }
  return ticks;
};
