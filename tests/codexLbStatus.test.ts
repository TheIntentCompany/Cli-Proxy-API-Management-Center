import { describe, expect, test } from 'bun:test';
import { codexLbKeyForApiKey, normalizeCodexLbStatus } from '../src/services/api/codexLb';
import { buildApiKeyRows, withoutApiKeyDuplicates } from '../src/features/dashboard/insights';
import type { RecentRequestUsageEntry } from '../src/utils/recentRequests';
import type { AuthFileItem } from '../src/types/authFile';

const SECRET = 'sk-clb-9b0cd907-THIS-PART-IS-SECRET-02';

const payload = {
  source: 'codex-lb',
  generated_at: '2026-11-13T20:10:24Z',
  keys: [
    {
      name: 'cliproxy-anvith',
      key_prefix: 'sk-clb-9b0cd907',
      active: true,
      scoped: true,
      accounts: [
        {
          id: 'abc123',
          email: 'person@example.com',
          alias: null,
          plan_type: 'pro',
          status: 'rate_limited',
          status_reason: null,
          blocked_until: 1794988931,
          windows: [
            {
              kind: 'weekly',
              used_percent: 100,
              reset_at: 1794988931,
              window_minutes: 10080,
              recorded_at: '2026-11-13T10:46:00Z',
            },
            { kind: 'bogus', used_percent: 5 },
          ],
        },
      ],
    },
    { name: '', key_prefix: 'x' },
  ],
};

const usage = (): Map<string, Map<string, RecentRequestUsageEntry>> =>
  new Map([
    [
      'codex',
      new Map([
        [
          `http://127.0.0.1:2455/backend-api/codex|${SECRET}`,
          { success: 9495, failed: 12, recentRequests: [{ success: 3, failed: 1 }] },
        ],
        ['https://api.example.com|sk-other-key-99', { success: 1, failed: 0, recentRequests: [] }],
      ]),
    ],
  ]);

const naming = {
  viaCodexLb: (accounts: string) => `${accounts} via codex-lb`,
  apiKey: (masked: string) => `API key ${masked}`,
};

describe('codex-lb status', () => {
  test('normalizes the endpoint payload and drops malformed parts', () => {
    const status = normalizeCodexLbStatus(payload);
    expect(status?.keys).toHaveLength(1);
    const account = status!.keys[0].accounts[0];
    expect(account.planType).toBe('pro');
    expect(account.blockedUntilMs).toBe(1794988931 * 1000);
    expect(account.windows).toHaveLength(1);
    expect(account.windows[0]).toMatchObject({ kind: 'weekly', usedPercent: 100 });
    expect(normalizeCodexLbStatus({ source: 'other', keys: [] })).toBeNull();
    expect(normalizeCodexLbStatus('nope')).toBeNull();
  });

  test('matches an API key to its codex-lb key by public prefix', () => {
    const status = normalizeCodexLbStatus(payload);
    expect(codexLbKeyForApiKey(status, SECRET)?.name).toBe('cliproxy-anvith');
    expect(codexLbKeyForApiKey(status, 'sk-other-key-99')).toBeNull();
    expect(codexLbKeyForApiKey(null, SECRET)).toBeNull();
  });

  test('names API-key rows after the codex-lb account and never exposes the key', () => {
    const rows = buildApiKeyRows(usage(), normalizeCodexLbStatus(payload), naming);
    expect(rows).toHaveLength(2);
    const [anvith, other] = rows;
    expect(anvith.name).toBe('person@example.com via codex-lb');
    expect(anvith.family).toBe('codex');
    expect(anvith.sinceStart).toEqual({ success: 9495, failed: 12 });
    expect(anvith.limits.weekly).toMatchObject({ usedPercent: 100, source: 'codex-lb' });
    expect(anvith.unavailable).toBe(true);
    expect(other.name).toBe('API key sk-…99');
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain('SECRET');
      expect(row.key).not.toContain('sk-');
    }
  });

  test('without the status service, API-key rows still count, masked', () => {
    const rows = buildApiKeyRows(usage(), null, naming);
    expect(rows[0].name).toBe('API key sk-…02');
    expect(rows[0].limits).toEqual({ fiveHour: null, weekly: null });
  });

  test('drops credential copies of API keys the usage endpoint already counts', () => {
    const files: AuthFileItem[] = [
      { name: 'oauth.json', provider: 'codex' },
      { name: 'key', provider: 'codex', account_type: 'api_key', account: SECRET },
    ];
    expect(withoutApiKeyDuplicates(files, usage()).map((file) => file.name)).toEqual([
      'oauth.json',
    ]);
  });
});
