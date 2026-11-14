/** One bar split by share, with a legend. Ported from T3 Code's UsageShareBar (MIT). */
import { formatPercent } from './format';
import styles from './usage.module.scss';

export interface ShareSegment {
  label: string;
  value: number;
  color: string;
}

export function ShareBar({
  label,
  segments,
  format,
  note,
}: {
  label: string;
  segments: ShareSegment[];
  format: (value: number) => string;
  note?: string;
}) {
  const visible = segments.filter((segment) => segment.value > 0);
  const total = visible.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) return null;
  return (
    <div className={styles.shareBar}>
      <div className={styles.shareHead}>
        <h3>{label}</h3>
        {note && <span>{note}</span>}
      </div>
      <div
        className={styles.shareTrack}
        role="img"
        aria-label={`${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`}
      >
        {visible.map((segment) => (
          <div
            key={segment.label}
            title={`${segment.label} · ${format(segment.value)} · ${formatPercent(segment.value / total)}`}
            style={{ flex: `${segment.value} 1 0`, background: segment.color }}
          />
        ))}
      </div>
      <div className={styles.shareLegend}>
        {visible.map((segment) => (
          <span key={segment.label}>
            <i style={{ background: segment.color }} aria-hidden="true" />
            <span className={styles.muted}>{segment.label}</span>
            <span>{format(segment.value)}</span>
            <span className={styles.muted}>{formatPercent(segment.value / total)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
