/** Number formats for usage figures, after T3 Code's usageFormat (MIT, see THIRD_PARTY_NOTICES.md). */

export const formatTokens = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(value));
};

export const formatUsd = (value: number): string => {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs > 0 ? 3 : 2;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

export const formatCount = (value: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);

export const formatPercent = (share: number | null): string => {
  if (share === null || !Number.isFinite(share)) return '–';
  const percent = share * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
};

export const formatMs = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '–';
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(value)} ms`;
};
