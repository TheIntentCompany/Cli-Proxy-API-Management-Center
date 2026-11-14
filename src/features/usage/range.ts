/**
 * The time range every usage view shares: 24 hours, 7 days, 30 days, all time or a custom
 * span. 24 hours buckets by hour; longer ranges bucket by day.
 */
import { useCallback, useMemo, useState } from 'react';

export type RangeId = '24h' | '7d' | '30d' | 'all' | 'custom';

export interface UsageRange {
  id: RangeId;
  /** Custom bounds, epoch ms; ignored for the presets. */
  customFrom?: number;
  customTo?: number;
}

export interface ResolvedRange {
  from: number;
  to: number;
  bucket: 'hour' | 'day';
}

export const RANGE_PRESETS: RangeId[] = ['24h', '7d', '30d', 'all'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STORAGE_KEY = 'intent.usage.range';

/** Start of the hour/day so buckets line up with the collector's rollups. */
const floorTo = (ms: number, step: number) => ms - (ms % step);

export function resolveRange(range: UsageRange, now: number, firstRecordAtMs: number | null) {
  const to = now;
  switch (range.id) {
    case '24h':
      return { from: floorTo(now - 23 * HOUR, HOUR), to, bucket: 'hour' } as ResolvedRange;
    case '7d':
      return { from: startOfLocalDay(now - 6 * DAY), to, bucket: 'day' } as ResolvedRange;
    case '30d':
      return { from: startOfLocalDay(now - 29 * DAY), to, bucket: 'day' } as ResolvedRange;
    case 'all':
      return {
        from: startOfLocalDay(firstRecordAtMs ?? now - 6 * DAY),
        to,
        bucket: 'day',
      } as ResolvedRange;
    case 'custom': {
      const from = range.customFrom ?? now - 7 * DAY;
      const end = Math.min(range.customTo ?? now, now);
      return { from, to: end, bucket: end - from <= 2 * DAY ? 'hour' : 'day' } as ResolvedRange;
    }
  }
}

export function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

const read = (): UsageRange => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as UsageRange | null;
    if (parsed && ['24h', '7d', '30d', 'all', 'custom'].includes(parsed.id)) return parsed;
  } catch {
    // Fall through to the default.
  }
  return { id: '24h' };
};

/** One range shared by Overview, Accounts and Requests, remembered in this browser. */
export function useUsageRange() {
  const [range, setRangeState] = useState<UsageRange>(read);
  const setRange = useCallback((next: UsageRange) => {
    setRangeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode: the range still applies for this visit.
    }
  }, []);
  return useMemo(() => ({ range, setRange }), [range, setRange]);
}
