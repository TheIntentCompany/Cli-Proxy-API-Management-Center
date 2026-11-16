import { describe, expect, test } from 'bun:test';
import type { PoolAccount } from '@/services/api/usage';
import {
  bankedResets,
  burnPerHour,
  memberStatuses,
  poolNow,
  project,
  recordedSeries,
} from '@/features/pool/model';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 15, 12);

const account = (overrides: Partial<PoolAccount> & Pick<PoolAccount, 'key'>): PoolAccount => ({
  provider: 'codex',
  label: null,
  plan: 'pro',
  via: null,
  authIndex: null,
  fileName: null,
  source: null,
  observedAtMs: NOW,
  stale: false,
  error: null,
  windows: [],
  bankedResets: null,
  limitedUntilMs: null,
  ...overrides,
});

const weekly = (used: number, resetsInHours: number | null) => ({
  kind: 'weekly' as const,
  usedPercent: used,
  resetsAtMs: resetsInHours === null ? null : NOW + resetsInHours * HOUR,
  windowMinutes: 7 * 24 * 60,
});

describe('pool weights', () => {
  test('Pro 500 counts 2.5 times a Pro 200 account', () => {
    const pool = poolNow(
      [
        account({ key: 'a', plan: 'promax', windows: [weekly(0, 48)] }),
        account({ key: 'b', plan: 'pro', windows: [weekly(50, 24)] }),
      ],
      'codex',
      'weekly',
      NOW
    );
    expect(pool.weighted).toBe(true);
    expect(pool.capacity).toBe(350);
    expect(pool.remaining).toBe(300);
  });

  test('one unknown plan makes every account count once', () => {
    const pool = poolNow(
      [
        account({ key: 'a', plan: 'promax', windows: [weekly(0, 48)] }),
        account({ key: 'b', plan: null, windows: [weekly(0, 24)] }),
      ],
      'codex',
      'weekly',
      NOW
    );
    expect(pool.weighted).toBe(false);
    expect(pool.capacity).toBe(200);
  });

  test('Claude accounts count once whatever the plan, and a passed reset counts as unused', () => {
    const pool = poolNow(
      [
        account({ key: 'a', provider: 'claude', plan: 'max', windows: [weekly(100, -1)] }),
        account({ key: 'b', provider: 'claude', plan: 'max', windows: [weekly(40, 10)] }),
      ],
      'claude',
      'weekly',
      NOW
    );
    expect(pool.capacity).toBe(200);
    expect(pool.remaining).toBe(160);
    // The passed reset rolls forward one week for projection.
    expect(pool.members[0].resetsAtMs).toBe(NOW - HOUR + 7 * 24 * HOUR);
  });
});

describe('recorded history and burn', () => {
  const accounts = [
    account({ key: 'a', provider: 'claude', windows: [weekly(30, 30)] }),
    account({ key: 'b', provider: 'claude', windows: [weekly(10, 60)] }),
  ];
  const pool = poolNow(accounts, 'claude', 'weekly', NOW);
  const history = [
    {
      key: 'a',
      kind: 'weekly' as const,
      points: [
        { t: NOW - 10 * HOUR, usedPercent: 0, resetsAtMs: NOW + 30 * HOUR },
        { t: NOW - 5 * HOUR, usedPercent: 20, resetsAtMs: NOW + 30 * HOUR },
      ],
    },
    {
      key: 'b',
      kind: 'weekly' as const,
      points: [{ t: NOW - 8 * HOUR, usedPercent: 10, resetsAtMs: NOW + 60 * HOUR }],
    },
  ];

  test('starts once every account has a reading and ends on the live value', () => {
    const series = recordedSeries(pool, history, NOW - 24 * HOUR, NOW);
    expect(series[0]).toEqual({ t: NOW - 8 * HOUR, value: 190 });
    expect(series.at(-1)).toEqual({ t: NOW, value: 160 });
  });

  test('burn rate counts drops only', () => {
    const series = [
      { t: NOW - 10 * HOUR, value: 200 },
      { t: NOW - 5 * HOUR, value: 150 },
      { t: NOW - 4 * HOUR, value: 250 },
      { t: NOW, value: 200 },
    ];
    expect(burnPerHour(series, NOW)).toBeCloseTo(10);
  });
});

describe('projection', () => {
  test('falls at the burn rate, jumps at a reset and reports when it runs out', () => {
    const pool = poolNow(
      [
        account({ key: 'a', provider: 'claude', windows: [weekly(50, 10)] }),
        account({ key: 'b', provider: 'claude', windows: [weekly(90, 200)] }),
      ],
      'claude',
      'weekly',
      NOW
    );
    const result = project(pool, 10, NOW, 48 * HOUR, HOUR);
    const jump = result.jumps[0];
    expect(jump.t).toBe(NOW + 10 * HOUR);
    expect(jump.member.account.key).toBe('a');
    expect(result.runsOutAt).not.toBeNull();
    expect(result.points.every((point) => point.value >= 0)).toBe(true);
  });
});

describe('account states and banked resets', () => {
  test('says which accounts are capped or held and when each comes back', () => {
    const accounts = [
      account({ key: 'open', provider: 'claude', windows: [weekly(15, 72)] }),
      account({ key: 'capped', provider: 'claude', windows: [weekly(100, 20)] }),
      account({
        key: 'locked',
        provider: 'claude',
        windows: [weekly(10, 20)],
        limitedUntilMs: NOW + 3 * HOUR,
      }),
      account({
        key: 'session',
        provider: 'claude',
        windows: [
          weekly(40, 50),
          { kind: 'five_hour', usedPercent: 100, resetsAtMs: NOW + 2 * HOUR, windowMinutes: 300 },
        ],
      }),
    ];
    const statuses = memberStatuses(poolNow(accounts, 'claude', 'weekly', NOW), NOW);
    expect(
      statuses.map((status) => [
        status.member.account.key,
        status.state,
        status.heldBy,
        status.backAtMs,
      ])
    ).toEqual([
      ['session', 'held', 'five_hour', NOW + 2 * HOUR],
      ['locked', 'held', 'lock', NOW + 3 * HOUR],
      ['capped', 'capped', null, NOW + 20 * HOUR],
      ['open', 'open', null, null],
    ]);
  });

  test('a spent weekly limit holds an account that still has Fable room', () => {
    const fable = poolNow(
      [
        account({
          key: 'a',
          provider: 'claude',
          windows: [
            weekly(100, 5),
            { kind: 'fable', usedPercent: 70, resetsAtMs: NOW + 5 * HOUR, windowMinutes: 10080 },
          ],
        }),
      ],
      'claude',
      'fable',
      NOW
    );
    expect(memberStatuses(fable, NOW)[0]).toMatchObject({
      state: 'held',
      heldBy: 'weekly',
      backAtMs: NOW + 5 * HOUR,
    });
  });

  test('adds banked resets across the pool and keeps the soonest expiry', () => {
    expect(
      bankedResets(
        [
          account({ key: 'a', bankedResets: { available: 2, nextExpiresAtMs: NOW + 9 * HOUR } }),
          account({ key: 'b', bankedResets: { available: 1, nextExpiresAtMs: NOW + 2 * HOUR } }),
          account({ key: 'c', bankedResets: null }),
        ],
        'codex'
      )
    ).toEqual({ available: 3, soonestExpiryMs: NOW + 2 * HOUR });
  });
});

describe('five-hour pool', () => {
  test('counts an account with no 5-hour window as free and a weekly-spent one as empty', () => {
    const pool = poolNow(
      [
        account({ key: 'a', provider: 'claude', windows: [weekly(10, 20)] }),
        account({ key: 'b', provider: 'claude', windows: [weekly(100, 20)] }),
        account({
          key: 'c',
          provider: 'claude',
          windows: [
            weekly(10, 20),
            { kind: 'five_hour', usedPercent: 40, resetsAtMs: NOW + HOUR, windowMinutes: 300 },
          ],
        }),
      ],
      'claude',
      'five_hour',
      NOW
    );
    expect(pool.capacity).toBe(300);
    expect(pool.remaining).toBe(160);
  });
});
