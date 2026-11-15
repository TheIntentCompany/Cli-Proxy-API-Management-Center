/**
 * Pooled limits: every account's remaining share of one window kind (weekly, 5-hour or
 * Claude's Fable weekly), added up, so six accounts with nothing used show 600%.
 *
 * Plan weights follow T3 Code's usage pooling (packages/shared/src/usageLimits.ts, MIT,
 * see THIRD_PARTY_NOTICES.md): Codex plans scale the 5-hour and weekly windows by their
 * allowance (Plus 1, Pro 100 5, Pro 200 20, and Pro 500 at 2.5 times Pro 200); Claude's
 * published multipliers describe sessions only, so Claude accounts count once. One account
 * with an unknown plan makes the pool count every account once.
 *
 * Weights are expressed against Pro 200 = 100%, so "Pro 500 = 2.5x" reads directly.
 */
import { normalizePlanType } from '@/utils/quota/parsers';
import {
  PRO_CODEX_PLAN_TYPE,
  PRO_LITE_CODEX_PLAN_TYPES,
  PRO_MAX_CODEX_PLAN_TYPES,
} from '@/utils/quota/planTier';
import type { PoolAccount, PoolHistory, PoolWindow, PoolWindowKind } from '@/services/api/usage';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Codex allowance in Pro 200 units. */
const CODEX_PLAN_WEIGHT: Array<[(plan: string) => boolean, number, string]> = [
  [(plan) => PRO_MAX_CODEX_PLAN_TYPES.has(plan), 2.5, 'promax'],
  [(plan) => plan === PRO_CODEX_PLAN_TYPE, 1, 'pro'],
  [(plan) => PRO_LITE_CODEX_PLAN_TYPES.has(plan), 0.25, 'prolite'],
  [(plan) => plan === 'plus', 0.05, 'plus'],
];

export function planWeight(account: PoolAccount, kind: PoolWindowKind): number | null {
  if (account.provider === 'claude') return 1;
  if (kind !== 'weekly' && kind !== 'five_hour') return 1;
  const plan = normalizePlanType(account.plan);
  if (!plan) return null;
  const match = CODEX_PLAN_WEIGHT.find(([test]) => test(plan));
  return match ? match[1] : null;
}

export interface PoolMember {
  account: PoolAccount;
  weight: number;
  /** Capacity in pool percent: 100 * weight. */
  capacity: number;
  /** Remaining now, in pool percent. */
  remaining: number;
  usedPercent: number | null;
  resetsAtMs: number | null;
  windowMs: number;
}

export interface PoolNow {
  kind: PoolWindowKind;
  members: PoolMember[];
  capacity: number;
  remaining: number;
  /** False when one plan was unknown and every account counted once. */
  weighted: boolean;
}

const windowOf = (account: PoolAccount, kind: PoolWindowKind) =>
  account.windows.find((window) => window.kind === kind) ?? null;

const defaultWindowMs = (kind: PoolWindowKind) =>
  kind === 'five_hour' ? 5 * HOUR : kind === 'monthly' ? 30 * DAY : WEEK;

/** Used percent at `t` given a reading; a reading whose reset has passed counts as unused. */
const usedAt = (used: number, resetsAtMs: number | null, t: number) =>
  resetsAtMs !== null && t >= resetsAtMs ? 0 : used;

const clampRemaining = (used: number) => Math.max(0, Math.min(100, 100 - used));

export function poolNow(
  accounts: PoolAccount[],
  provider: 'claude' | 'codex',
  kind: PoolWindowKind,
  now: number
): PoolNow {
  // The 5-hour pool counts every account: one with no 5-hour window has not started one
  // (all of it is free), and one whose weekly limit is spent cannot use its 5-hour room
  // until the weekly reset (T3 Code's poolMember rule).
  const sessionWindow = (account: PoolAccount): PoolWindow | null => {
    const weekly = windowOf(account, 'weekly');
    if (weekly && usedAt(weekly.usedPercent, weekly.resetsAtMs, now) >= 100) {
      return {
        kind: 'five_hour',
        usedPercent: 100,
        resetsAtMs: weekly.resetsAtMs,
        windowMinutes: null,
      };
    }
    return (
      windowOf(account, 'five_hour') ?? {
        kind: 'five_hour',
        usedPercent: 0,
        resetsAtMs: null,
        windowMinutes: 300,
      }
    );
  };
  const pick = (account: PoolAccount) =>
    kind === 'five_hour'
      ? account.windows.length > 0
        ? sessionWindow(account)
        : null
      : windowOf(account, kind);
  const inPool = accounts.filter(
    (account) => account.provider === provider && pick(account) !== null
  );
  const weights = inPool.map((account) => planWeight(account, kind));
  const weighted = weights.every((weight) => weight !== null);
  const members = inPool.map((account, index) => {
    const window = pick(account)!;
    const weight = weighted ? (weights[index] as number) : 1;
    const used = usedAt(window.usedPercent, window.resetsAtMs, now);
    // A reset that already happened moves to the next cycle for projection purposes.
    const windowMs = window.windowMinutes ? window.windowMinutes * 60_000 : defaultWindowMs(kind);
    let resetsAtMs = window.resetsAtMs;
    while (resetsAtMs !== null && resetsAtMs <= now) resetsAtMs += windowMs;
    return {
      account,
      weight,
      capacity: 100 * weight,
      remaining: clampRemaining(used) * weight,
      usedPercent: used,
      resetsAtMs,
      windowMs,
    };
  });
  return {
    kind,
    members,
    capacity: members.reduce((sum, member) => sum + member.capacity, 0),
    remaining: members.reduce((sum, member) => sum + member.remaining, 0),
    weighted,
  };
}

export interface PoolPoint {
  t: number;
  value: number;
}

/**
 * Recorded pool over time, as step points: the pool's value changes only where a member
 * reported a new reading or one of its windows reset. The line starts once every member
 * has a reading, so it never counts a missing account as full or empty.
 */
export function recordedSeries(
  pool: PoolNow,
  history: PoolHistory[],
  from: number,
  now: number
): PoolPoint[] {
  const byKey = new Map(
    history.filter((entry) => entry.kind === pool.kind).map((entry) => [entry.key, entry.points])
  );
  const tracks = pool.members.map((member) => ({
    member,
    points: (byKey.get(member.account.key) ?? []).filter((point) => point.t <= now),
  }));
  if (tracks.length === 0 || tracks.some((track) => track.points.length === 0)) return [];
  const start = Math.max(from, ...tracks.map((track) => track.points[0].t));
  const times = new Set<number>([start, now]);
  for (const { points } of tracks) {
    for (const point of points) {
      if (point.t > start && point.t < now) times.add(point.t);
      if (point.resetsAtMs !== null && point.resetsAtMs > start && point.resetsAtMs < now) {
        times.add(point.resetsAtMs);
      }
    }
  }
  const valueAt = (t: number) =>
    tracks.reduce((sum, { member, points }) => {
      let last = points[0];
      for (const point of points) {
        if (point.t > t) break;
        last = point;
      }
      return sum + clampRemaining(usedAt(last.usedPercent, last.resetsAtMs, t)) * member.weight;
    }, 0);
  const sorted = [...times].sort((a, b) => a - b);
  const series = sorted.map((t) => ({ t, value: valueAt(t) }));
  // The live reading is the most current figure; end the recorded line on it.
  series[series.length - 1] = { t: now, value: pool.remaining };
  return series;
}

/** Pool percent spent per hour over the last `lookbackMs`, ignoring reset jumps. */
export function burnPerHour(series: PoolPoint[], now: number, lookbackMs = DAY): number | null {
  const recent = series.filter((point) => point.t >= now - lookbackMs);
  if (recent.length < 2) return null;
  const span = recent[recent.length - 1].t - recent[0].t;
  if (span < HOUR) return null;
  let spent = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const drop = recent[index - 1].value - recent[index].value;
    if (drop > 0) spent += drop;
  }
  return (spent / span) * HOUR;
}

export interface ProjectedJump {
  t: number;
  /** Pool percent this reset brings back. */
  gain: number;
  member: PoolMember;
}

export interface Projection {
  points: PoolPoint[];
  jumps: ProjectedJump[];
  /** First time the pool reaches zero at this rate, if it does within the horizon. */
  runsOutAt: number | null;
}

/**
 * Projects the pool forward at the current burn rate. Spending is shared across members
 * that still have room, in proportion to their weight (routing spreads load); a member
 * that empties stops absorbing spend; each reset refills that member to its capacity.
 */
export function project(
  pool: PoolNow,
  ratePerHour: number,
  now: number,
  horizonMs = WEEK,
  stepMs = 15 * 60_000
): Projection {
  const state = pool.members.map((member) => ({
    member,
    remaining: member.remaining,
    nextReset: member.resetsAtMs,
  }));
  const points: PoolPoint[] = [{ t: now, value: pool.remaining }];
  const jumps: ProjectedJump[] = [];
  let runsOutAt: number | null = null;
  const end = now + horizonMs;
  for (let t = now; t < end; t += stepMs) {
    const next = Math.min(t + stepMs, end);
    // Resets inside this step happen first, so the refill shows as a vertical jump.
    const due = state
      .filter((entry) => entry.nextReset !== null && entry.nextReset <= next)
      .sort((a, b) => (a.nextReset as number) - (b.nextReset as number));
    for (const entry of due) {
      const at = entry.nextReset as number;
      const before = state.reduce((sum, item) => sum + item.remaining, 0);
      const gain = entry.member.capacity - entry.remaining;
      entry.remaining = entry.member.capacity;
      entry.nextReset = at + entry.member.windowMs;
      if (gain >= 0.5) {
        points.push({ t: at, value: before });
        points.push({ t: at, value: before + gain });
        jumps.push({ t: at, gain, member: entry.member });
      }
    }
    let spend = (ratePerHour * (next - t)) / HOUR;
    // Spread spend over members with room, refilling the share of any that empty.
    for (let round = 0; round < state.length && spend > 1e-9; round += 1) {
      const open = state.filter((entry) => entry.remaining > 1e-9);
      const totalWeight = open.reduce((sum, entry) => sum + entry.member.weight, 0);
      if (totalWeight === 0) break;
      let left = 0;
      for (const entry of open) {
        const share = (spend * entry.member.weight) / totalWeight;
        const taken = Math.min(share, entry.remaining);
        entry.remaining -= taken;
        left += share - taken;
      }
      spend = left;
    }
    const value = state.reduce((sum, entry) => sum + entry.remaining, 0);
    if (runsOutAt === null && value <= 0.5 && ratePerHour > 0) runsOutAt = next;
    points.push({ t: next, value });
  }
  return { points, jumps, runsOutAt };
}

/** Upcoming resets in time order, with the pool percent each brings back right now. */
export function upcomingResets(pool: PoolNow) {
  return pool.members
    .filter((member) => member.resetsAtMs !== null)
    .map((member) => ({
      member,
      at: member.resetsAtMs as number,
      restores: member.capacity - member.remaining,
    }))
    .sort((a, b) => a.at - b.at);
}

/** Accounts that cannot serve now, and when they reopen. */
export function limitedAccounts(
  accounts: PoolAccount[],
  provider: 'claude' | 'codex',
  now: number
) {
  return accounts
    .filter((account) => account.provider === provider)
    .flatMap((account) => {
      const spent = account.windows
        .filter((window) => usedAt(window.usedPercent, window.resetsAtMs, now) >= 100)
        .filter((window) => window.kind === 'weekly' || window.kind === 'five_hour');
      const lockedUntil =
        account.limitedUntilMs !== null && account.limitedUntilMs > now
          ? account.limitedUntilMs
          : null;
      if (spent.length === 0 && lockedUntil === null) return [];
      // It reopens when every spent window has reset, or when the lock ends.
      const reopen = Math.max(lockedUntil ?? 0, ...spent.map((window) => window.resetsAtMs ?? 0));
      return [{ account, reopensAtMs: reopen > now ? reopen : null, windows: spent }];
    })
    .sort((a, b) => (a.reopensAtMs ?? Infinity) - (b.reopensAtMs ?? Infinity));
}

export function bankedResets(accounts: PoolAccount[], provider: 'claude' | 'codex') {
  let available = 0;
  let known = false;
  let soonest: number | null = null;
  for (const account of accounts) {
    if (account.provider !== provider || !account.bankedResets) continue;
    if (account.bankedResets.available !== null) {
      known = true;
      available += account.bankedResets.available;
    }
    const expiry = account.bankedResets.nextExpiresAtMs;
    if (expiry !== null && (soonest === null || expiry < soonest)) soonest = expiry;
  }
  return { available: known ? available : null, soonestExpiryMs: soonest };
}

/** Labels like "Pro 500 = 2.5x" for the weights that differ from 1. */
export function weightNotes(pool: PoolNow): Array<{ plan: string; weight: number }> {
  if (!pool.weighted) return [];
  const seen = new Map<string, number>();
  for (const member of pool.members) {
    if (member.weight !== 1 && member.account.plan) {
      seen.set(normalizePlanType(member.account.plan) ?? member.account.plan, member.weight);
    }
  }
  return [...seen].map(([plan, weight]) => ({ plan, weight }));
}
