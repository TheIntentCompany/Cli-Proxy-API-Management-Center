import { describe, expect, test } from 'bun:test';
import {
  BUCKETS_PER_WINDOW,
  alignBuckets,
  bucketEndsMinutesAgo,
  buildAccountRows,
  claudeCodexSplit,
  combineBuckets,
  familyOf,
  limitsFromHeaders,
  limitsFromUsage,
  mergeLimits,
  seriesByFamily,
  successRateSeries,
} from '../src/features/dashboard/insights';
import { formatRelative } from '../src/utils/relativeTime';
import type { AuthFileItem } from '../src/types/authFile';

const buckets = (pairs: Array<[number, number]>) =>
  pairs.map(([success, failed]) => ({ success, failed }));

const file = (overrides: Partial<AuthFileItem> & Record<string, unknown>): AuthFileItem => ({
  name: 'a.json',
  ...overrides,
});

describe('dashboard insights', () => {
  test('maps providers to the two families the headline compares', () => {
    expect(familyOf('claude')).toBe('claude');
    expect(familyOf(' Codex ')).toBe('codex');
    expect(familyOf('gemini')).toBe('other');
  });

  test('aligns short bucket lists to the end of the window', () => {
    const aligned = alignBuckets(buckets([[3, 1]]));
    expect(aligned).toHaveLength(BUCKETS_PER_WINDOW);
    expect(aligned[BUCKETS_PER_WINDOW - 1]).toEqual({ success: 3, failed: 1 });
    expect(aligned[0]).toEqual({ success: 0, failed: 0 });
  });

  test('reads Anthropic fractions and Codex percents from stored headers', () => {
    const claude = limitsFromHeaders(
      file({
        provider: 'claude',
        quota: {
          observed_at: '2026-11-13T10:00:00Z',
          signals: {
            'Anthropic-Ratelimit-Unified-7d-Utilization': '0.99',
            'Anthropic-Ratelimit-Unified-7d-Reset': '1794787200',
          },
        },
      })
    );
    expect(claude.fiveHour).toBeNull();
    expect(claude.weekly?.usedPercent).toBeCloseTo(99);
    expect(claude.weekly?.resetAtMs).toBe(1794787200 * 1000);
    expect(claude.weekly?.source).toBe('headers');

    const codex = limitsFromHeaders(
      file({
        provider: 'codex',
        quota: {
          signals: {
            'X-Codex-Primary-Used-Percent': '60',
            'X-Codex-Primary-Window-Minutes': '10080',
            'X-Codex-Secondary-Used-Percent': '0',
            'X-Codex-Secondary-Window-Minutes': '0',
          },
        },
      })
    );
    // The primary window is weekly on this plan; a zero-length secondary window is absent.
    expect(codex.weekly?.usedPercent).toBe(60);
    expect(codex.fiveHour).toBeNull();
  });

  test('prefers a usage read over headers, window by window', () => {
    const usage = limitsFromUsage(
      {
        status: 'success',
        windows: [
          { id: 'five-hour', label: '5h', usedPercent: 12, resetLabel: '', resetAtMs: 1 },
          { id: 'seven-day', label: '7d', usedPercent: null, resetLabel: '' },
        ],
      },
      'seven-day'
    );
    const headers = {
      fiveHour: null,
      weekly: { usedPercent: 40, resetAtMs: null, source: 'headers' as const, observedAtMs: null },
    };
    const merged = mergeLimits(usage, headers);
    expect(merged.fiveHour?.usedPercent).toBe(12);
    expect(merged.fiveHour?.source).toBe('usage');
    expect(merged.weekly?.usedPercent).toBe(40);
    expect(limitsFromUsage({ status: 'error', windows: [] }, 'weekly').weekly).toBeNull();
  });

  test('sums requests per family and splits Claude against Codex', () => {
    const rows = buildAccountRows(
      [
        file({
          name: 'c1',
          provider: 'claude',
          recent_requests: buckets([
            [2, 0],
            [4, 1],
          ]),
        }),
        file({
          name: 'c2',
          provider: 'claude',
          recent_requests: buckets([
            [1, 0],
            [1, 0],
          ]),
        }),
        file({
          name: 'x1',
          provider: 'codex',
          recent_requests: buckets([
            [0, 0],
            [3, 0],
          ]),
        }),
      ],
      { claude: {}, codex: {} }
    );
    const series = seriesByFamily(rows, 2);
    expect(series.map((item) => item.family)).toEqual(['claude', 'codex']);
    expect(series[0].values).toEqual([3, 6]);
    expect(series[0].failed).toBe(1);
    expect(series[1].values).toEqual([0, 3]);

    const split = claudeCodexSplit(series);
    expect(split.claudeShare).toBeCloseTo(75);
    expect(split.leadPoints).toBeCloseTo(50);
    expect(claudeCodexSplit([]).claudeShare).toBeNull();
  });

  test('leaves empty buckets out of the success-rate line', () => {
    const combined = combineBuckets(
      buildAccountRows(
        [
          file({
            provider: 'claude',
            recent_requests: buckets([
              [0, 0],
              [3, 1],
            ]),
          }),
        ],
        {
          claude: {},
          codex: {},
        }
      ),
      2
    );
    expect(successRateSeries(combined)).toEqual([null, 75]);
  });

  test('labels buckets by minutes before now', () => {
    expect(bucketEndsMinutesAgo(19, 20)).toBe(0);
    expect(bucketEndsMinutesAgo(0, 20)).toBe(190);
  });

  test('never uses the account field as a display name', () => {
    const [row] = buildAccountRows(
      [
        file({
          name: 'key.json',
          provider: 'codex',
          account: 'sk-secret',
          account_type: 'api_key',
        }),
      ],
      { claude: {}, codex: {} }
    );
    expect(row.name).toBe('key.json');
  });
});

describe('formatRelative', () => {
  test('uses the largest whole unit', () => {
    const now = Date.UTC(2026, 10, 13, 10, 0);
    expect(formatRelative(now + 2 * 86_400_000 + 5 * 3_600_000, now, 'en')).toBe('in 2 days');
    expect(formatRelative(now - 3 * 60_000, now, 'en')).toBe('3 minutes ago');
    expect(formatRelative(now + 10_000, now, 'en')).toBe('this minute');
  });
});
