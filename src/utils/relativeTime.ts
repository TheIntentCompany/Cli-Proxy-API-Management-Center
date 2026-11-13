/**
 * Short, localized "in 3 days" / "5 minutes ago" strings. The largest whole unit wins,
 * so a reset 2 days and 20 hours away reads "in 2 days" rather than a precise clock.
 */
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelative(targetMs: number, nowMs: number, locale?: string): string {
  const delta = targetMs - nowMs;
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'long' });
  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      const value = Math.floor(abs / size);
      return formatter.format(delta < 0 ? -value : value, unit);
    }
  }
  return formatter.format(0, 'minute');
}

/** "Dec 10, 14:00" in the viewer's zone, for a precise reset or expiry instant. */
export function formatShortDateTime(targetMs: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(targetMs));
}
