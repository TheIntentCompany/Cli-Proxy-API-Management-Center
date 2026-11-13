/**
 * codex-lb accounts that CLIProxyAPI reaches through a Codex API key.
 *
 * Those upstream accounts are not CLIProxyAPI credentials, so the management API does
 * not list them. Intent's deployment runs a loopback-only, read-only status service
 * beside codex-lb (deploy/codex-lb-status); the panel reaches it through the
 * management `api-call` proxy without an auth index, so no credential is attached.
 * Where that service is absent the call fails and the panel simply shows nothing.
 */
import { apiCallApi } from './apiCall';
import { isRecord } from '@/utils/helpers';

export const CODEX_LB_STATUS_URL = 'http://127.0.0.1:8335/v1/accounts';

export type CodexLbWindowKind = 'five_hour' | 'weekly' | 'monthly' | 'other';

export interface CodexLbWindow {
  kind: CodexLbWindowKind;
  /** 0 to 100. */
  usedPercent: number | null;
  resetAtMs: number | null;
  windowMinutes: number;
  recordedAtMs: number | null;
  /** Recorded long before the account's newest window, likely from an earlier plan. */
  stale: boolean;
}

export interface CodexLbAccount {
  /** Opaque, stable handle; not codex-lb's internal id. */
  id: string;
  email: string | null;
  alias: string | null;
  planType: string | null;
  /** codex-lb account status, for example active, rate_limited, quota_exceeded, paused. */
  status: string | null;
  statusReason: string | null;
  /** When codex-lb expects a blocked account to recover. */
  blockedUntilMs: number | null;
  windows: CodexLbWindow[];
}

export interface CodexLbKey {
  /** codex-lb API key name, for example cliproxy-anvith. */
  name: string;
  /** The key's public prefix, used to match CLIProxyAPI's API-key entry. */
  keyPrefix: string | null;
  active: boolean;
  accounts: CodexLbAccount[];
}

export interface CodexLbStatus {
  generatedAtMs: number | null;
  keys: CodexLbKey[];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const epochSecondsToMs = (value: unknown): number | null => {
  const parsed = finite(value);
  return parsed !== null && parsed > 0 ? parsed * 1000 : null;
};

const isoToMs = (value: unknown): number | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeWindow = (input: unknown): CodexLbWindow | null => {
  if (!isRecord(input)) return null;
  const kind = input.kind;
  if (kind !== 'five_hour' && kind !== 'weekly' && kind !== 'monthly' && kind !== 'other') {
    return null;
  }
  const used = finite(input.used_percent);
  return {
    kind,
    usedPercent: used === null ? null : Math.min(100, Math.max(0, used)),
    resetAtMs: epochSecondsToMs(input.reset_at),
    windowMinutes: finite(input.window_minutes) ?? 0,
    recordedAtMs: isoToMs(input.recorded_at),
    stale: input.stale === true,
  };
};

const normalizeAccount = (input: unknown): CodexLbAccount | null => {
  if (!isRecord(input)) return null;
  const id = text(input.id);
  if (!id) return null;
  return {
    id,
    email: text(input.email),
    alias: text(input.alias),
    planType: text(input.plan_type),
    status: text(input.status),
    statusReason: text(input.status_reason),
    blockedUntilMs: epochSecondsToMs(input.blocked_until),
    // Stale windows describe an earlier plan; they are not current limits.
    windows: Array.isArray(input.windows)
      ? input.windows.map(normalizeWindow).filter((w): w is CodexLbWindow => w !== null && !w.stale)
      : [],
  };
};

export const normalizeCodexLbStatus = (input: unknown): CodexLbStatus | null => {
  if (!isRecord(input) || input.source !== 'codex-lb' || !Array.isArray(input.keys)) return null;
  const keys: CodexLbKey[] = [];
  for (const raw of input.keys) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name);
    if (!name) continue;
    keys.push({
      name,
      keyPrefix: text(raw.key_prefix),
      active: raw.active === true,
      accounts: Array.isArray(raw.accounts)
        ? raw.accounts.map(normalizeAccount).filter((a): a is CodexLbAccount => a !== null)
        : [],
    });
  }
  return { generatedAtMs: isoToMs(input.generated_at), keys };
};

/** The codex-lb key a CLIProxyAPI API-key entry uses, matched by the key's public prefix. */
export const codexLbKeyForApiKey = (
  status: CodexLbStatus | null,
  apiKey: string
): CodexLbKey | null => {
  const key = apiKey.trim();
  if (!status || !key) return null;
  return (
    status.keys.find((candidate) => candidate.keyPrefix && key.startsWith(candidate.keyPrefix)) ??
    null
  );
};

/** Every codex-lb account the status service reports, paired with its key. */
export const flattenCodexLbAccounts = (keys: CodexLbKey[] | undefined) =>
  (keys ?? []).flatMap((keyInfo) => keyInfo.accounts.map((account) => ({ account, keyInfo })));

/** A display name for an upstream account: alias, then email. */
export const codexLbAccountName = (account: CodexLbAccount): string =>
  account.alias || account.email || account.id;

export const codexLbApi = {
  getStatus: async (): Promise<CodexLbStatus | null> => {
    const result = await apiCallApi.request(
      { method: 'GET', url: CODEX_LB_STATUS_URL, header: { Accept: 'application/json' } },
      { timeout: 10_000 }
    );
    if (result.statusCode !== 200) return null;
    return normalizeCodexLbStatus(result.body);
  },
};
