/**
 * Pool capacity over time: the recorded line (solid, filled) up to now, then a dashed
 * projection that falls at the current burn rate and jumps where an account resets.
 * Each jump is labelled with what it brings back, like T3 Code's pooled limits chart.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { PoolPoint, ProjectedJump } from './model';
import styles from './pool.module.scss';

const MARGIN = { top: 26, right: 16, bottom: 28, left: 48 };
const DAY = 86_400_000;

const formatPercent = (value: number) => `${Math.round(value)}%`;

export function PoolChart({
  recorded,
  projected,
  jumps,
  capacity,
  from,
  to,
  now,
  color,
  height = 260,
  locale,
  nowLabel,
  ariaLabel,
}: {
  recorded: PoolPoint[];
  projected: PoolPoint[];
  jumps: ProjectedJump[];
  capacity: number;
  from: number;
  to: number;
  now: number;
  color: string;
  height?: number;
  locale?: string;
  nowLabel: string;
  ariaLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = `pool-fill-${useId().replace(/:/g, '')}`;

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => setWidth(Math.round(node.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const top = Math.max(
    capacity,
    ...recorded.map((p) => p.value),
    ...projected.map((p) => p.value),
    1
  );
  const x = (t: number) => MARGIN.left + ((t - from) / Math.max(1, to - from)) * plotW;
  const y = (value: number) => MARGIN.top + plotH - (Math.max(0, value) / top) * plotH;

  // Recorded readings hold until the next one, so draw them as steps.
  const recordedPath = recorded
    .map((point, index) =>
      index === 0
        ? `M${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`
        : `H${x(point.t).toFixed(1)}V${y(point.value).toFixed(1)}`
    )
    .join('');
  const recordedArea =
    recorded.length > 1 ? `${recordedPath}V${y(0).toFixed(1)}H${x(recorded[0].t).toFixed(1)}Z` : '';
  const projectedPath = projected
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(point.value).toFixed(1)}`
    )
    .join('');

  // Recorded refills (a reset or a redeemed reset) get the same "+N%" label as projected ones.
  const recordedJumps = recorded.flatMap((point, index) => {
    if (index === 0) return [];
    const gain = point.value - recorded[index - 1].value;
    return gain >= 2 ? [{ t: point.t, top: point.value, gain }] : [];
  });
  const projectedJumps = jumps.map((jump) => {
    const after = projected.find(
      (point, index) => point.t === jump.t && index > 0 && projected[index - 1].t === jump.t
    );
    return { t: jump.t, top: after?.value ?? 0, gain: jump.gain };
  });
  // Keep labels apart so neighbouring resets stay readable.
  const labels: Array<{ t: number; top: number; gain: number }> = [];
  for (const label of [...recordedJumps, ...projectedJumps].sort((a, b) => a.t - b.t)) {
    const last = labels[labels.length - 1];
    if (last && Math.abs(x(label.t) - x(last.t)) < 44) continue;
    // The "Now" label sits on the same line; keep jump labels off it.
    if (Math.abs(x(label.t) - x(now)) < 28) continue;
    labels.push(label);
  }

  const ticks: number[] = [];
  const first = new Date(from);
  first.setHours(0, 0, 0, 0);
  for (let t = first.getTime() + DAY; t < to; t += DAY) ticks.push(t);
  const step = Math.max(1, Math.ceil(ticks.length / Math.max(1, Math.floor(plotW / 70))));

  const all = [...recorded, ...projected].sort((a, b) => a.t - b.t);
  const hovered =
    hover === null
      ? null
      : all.reduce(
          (best, point) => (Math.abs(point.t - hover) < Math.abs(best.t - hover) ? point : best),
          all[0]
        );

  return (
    <div
      ref={wrapRef}
      className={styles.chart}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
      onPointerMove={(event) => {
        const left = event.currentTarget.getBoundingClientRect().left;
        const ratio = (event.clientX - left - MARGIN.left) / Math.max(1, plotW);
        if (ratio < 0 || ratio > 1) setHover(null);
        else setHover(from + ratio * (to - from));
      }}
      onPointerLeave={() => setHover(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0, top / 2, top].map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                className={styles.grid}
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className={styles.axis}
              >
                {formatPercent(tick)}
              </text>
            </g>
          ))}
          {ticks.map((t, index) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                className={styles.gridDay}
              />
              {index % step === 0 && (
                <text x={x(t) + 4} y={height - 8} className={styles.axis}>
                  {`${new Date(t).toLocaleDateString(locale, { weekday: 'short' })} ${new Date(t).getDate()}`}
                </text>
              )}
            </g>
          ))}
          {recordedArea && <path d={recordedArea} fill={`url(#${gradientId})`} />}
          {recordedPath && <path d={recordedPath} className={styles.recorded} stroke={color} />}
          {projectedPath && <path d={projectedPath} className={styles.projected} stroke={color} />}
          <line
            x1={x(now)}
            x2={x(now)}
            y1={MARGIN.top - 8}
            y2={MARGIN.top + plotH}
            className={styles.now}
          />
          <text x={x(now)} y={MARGIN.top - 12} textAnchor="middle" className={styles.axis}>
            {nowLabel}
          </text>
          {projected.length > 0 && (
            <circle
              cx={x(now)}
              cy={y(projected[0].value)}
              r={4.5}
              fill={color}
              className={styles.dot}
            />
          )}
          {labels.map((label) => (
            <text
              key={`${label.t}-${label.gain}`}
              x={x(label.t)}
              y={y(label.top) - 8}
              textAnchor="middle"
              className={styles.jumpLabel}
            >
              +{formatPercent(label.gain)}
            </text>
          ))}
          {hovered && (
            <g>
              <line
                x1={x(hovered.t)}
                x2={x(hovered.t)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                className={styles.cross}
              />
              <circle cx={x(hovered.t)} cy={y(hovered.value)} r={3.5} fill={color} />
            </g>
          )}
        </svg>
      )}
      {hovered && width > 0 && (
        <div
          className={styles.tooltip}
          style={{
            left: x(hovered.t) > width - 180 ? undefined : x(hovered.t) + 10,
            right: x(hovered.t) > width - 180 ? width - x(hovered.t) + 10 : undefined,
            top: MARGIN.top,
          }}
        >
          <div>
            {new Date(hovered.t).toLocaleString(locale, {
              weekday: 'short',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </div>
          <strong>{formatPercent(hovered.value)}</strong>
        </div>
      )}
    </div>
  );
}
