import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { axisMax } from '../utils';
import styles from './LineChart.module.scss';

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
  /** Draw a faint wash under the line. */
  area?: boolean;
}

export interface LineMarker {
  index: number;
  seriesId: string;
}

interface LineChartProps {
  series: LineSeries[];
  ariaLabel: string;
  /** Label for the x position, used by ticks, the tooltip and the table. */
  xLabel: (index: number) => string;
  /** Indices that get an axis tick. */
  xTicks: number[];
  yFormat: (value: number) => string;
  valueFormat: (value: number) => string;
  /** Fixed ceiling, for example 100 for percentages. */
  yMax?: number;
  yMin?: number;
  height?: number;
  /** Points drawn as hollow red dots, for example buckets that had failures. */
  markers?: LineMarker[];
  markerColor?: string;
  extraRows?: (index: number) => Array<{ label: string; value: string }>;
}

const MARGIN = { top: 14, right: 132, bottom: 30, left: 44 };
const LABEL_GAP = 18;

const buildPath = (points: Array<[number, number] | null>): string => {
  let d = '';
  let pen = false;
  for (const point of points) {
    if (!point) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
    pen = true;
  }
  return d;
};

/** Spread end labels so they never overlap; each keeps a leader line to its point. */
const spreadLabels = <T extends { y: number; labelY: number }>(
  items: T[],
  min: number,
  max: number
): T[] => {
  const sorted = [...items].sort((a, b) => a.y - b.y).map((item) => ({ ...item, labelY: item.y }));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].labelY - sorted[i - 1].labelY < LABEL_GAP) {
      sorted[i].labelY = sorted[i - 1].labelY + LABEL_GAP;
    }
  }
  const overflow = (sorted.length > 0 ? sorted[sorted.length - 1].labelY : 0) - max;
  if (overflow > 0) sorted.forEach((item) => (item.labelY -= overflow));
  sorted.forEach((item) => (item.labelY = Math.max(min, item.labelY)));
  return sorted;
};

/**
 * Multi-series line chart in the dashboard's hairline style. Series are named at
 * their line ends instead of in a legend box; the crosshair tooltip lists every
 * series at the hovered position and the hidden table carries the same values.
 */
export function LineChart({
  series,
  ariaLabel,
  xLabel,
  xTicks,
  yFormat,
  valueFormat,
  yMax,
  yMin = 0,
  height = 340,
  markers = [],
  markerColor = 'var(--viz-failure)',
  extraRows,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const update = () => setWidth(Math.round(node.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const count = series[0]?.values.length ?? 0;
  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const ceiling = useMemo(() => {
    if (yMax !== undefined) return yMax;
    const peak = Math.max(0, ...series.flatMap((item) => item.values.map((v) => v ?? 0)));
    return axisMax(peak, 4);
  }, [series, yMax]);

  const x = (index: number) =>
    MARGIN.left + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value: number) =>
    MARGIN.top + plotH - ((value - yMin) / Math.max(1e-9, ceiling - yMin)) * plotH;

  const ticks = [0, 1, 2, 3, 4].map((step) => yMin + ((ceiling - yMin) * step) / 4);

  const lines = series.map((item) => {
    const points = item.values.map((value, index) =>
      value === null ? null : ([x(index), y(value)] as [number, number])
    );
    let lastIndex = -1;
    item.values.forEach((value, index) => {
      if (value !== null) lastIndex = index;
    });
    const area =
      item.area && lastIndex >= 0
        ? `${buildPath(points)}L${x(lastIndex).toFixed(1)},${y(yMin).toFixed(1)}L${x(
            item.values.findIndex((value) => value !== null)
          ).toFixed(1)},${y(yMin).toFixed(1)}Z`
        : null;
    return { item, path: buildPath(points), area, lastIndex };
  });

  const endLabels = spreadLabels(
    lines
      .filter((line) => line.lastIndex >= 0)
      .map((line) => ({
        id: line.item.id,
        label: line.item.label,
        color: line.item.color,
        value: line.item.values[line.lastIndex] as number,
        x: x(line.lastIndex),
        y: y(line.item.values[line.lastIndex] as number),
        labelY: 0,
      })),
    MARGIN.top + 6,
    MARGIN.top + plotH
  );

  const pick = (clientX: number) => {
    const node = wrapRef.current;
    if (!node || count === 0) return;
    const left = node.getBoundingClientRect().left;
    const ratio = (clientX - left - MARGIN.left) / Math.max(1, plotW);
    setActive(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      setActive((current) =>
        Math.min(count - 1, Math.max(0, (current ?? count - 1) + (current === null ? 0 : step)))
      );
    } else if (event.key === 'Escape') {
      setActive(null);
    }
  };

  const tooltipLeft = active === null ? 0 : x(active);
  const flip = tooltipLeft > width - MARGIN.right - 160;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      style={{ height }}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      onPointerMove={(event) => pick(event.clientX)}
      onPointerLeave={() => setActive(null)}
      onFocus={() => setActive((current) => current ?? (count > 0 ? count - 1 : null))}
      onBlur={() => setActive(null)}
      onKeyDown={onKeyDown}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" className={styles.svg}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === yMin ? styles.baseline : styles.grid}
              />
              <text x={MARGIN.left - 10} y={y(tick)} dy="0.32em" className={styles.yTick}>
                {yFormat(tick)}
              </text>
            </g>
          ))}
          {xTicks.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 8}
              className={styles.xTick}
              textAnchor={index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'}
            >
              {xLabel(index)}
            </text>
          ))}
          {lines.map(
            ({ item, area }) =>
              area && <path key={`${item.id}-area`} d={area} fill={item.color} opacity={0.07} />
          )}
          {lines.map(({ item, path }) => (
            <path key={item.id} d={path} className={styles.line} stroke={item.color} />
          ))}
          {markers.map((marker) => {
            const owner = series.find((item) => item.id === marker.seriesId);
            const value = owner?.values[marker.index];
            if (value === null || value === undefined) return null;
            return (
              <circle
                key={`${marker.seriesId}-${marker.index}`}
                cx={x(marker.index)}
                cy={y(value)}
                r={4}
                className={styles.marker}
                stroke={markerColor}
              />
            );
          })}
          {endLabels.map((label) => (
            <g key={label.id}>
              <circle cx={label.x} cy={label.y} r={4} fill={label.color} className={styles.dot} />
              <path
                d={`M${label.x + 6},${label.y}L${label.x + 14},${label.labelY}L${label.x + 20},${label.labelY}`}
                className={styles.leader}
              />
              <line
                x1={label.x + 24}
                x2={label.x + 36}
                y1={label.labelY}
                y2={label.labelY}
                stroke={label.color}
                strokeWidth={2}
                strokeLinecap="round"
              />
              <text x={label.x + 42} y={label.labelY} dy="0.32em" className={styles.endLabel}>
                {label.label}
                <tspan className={styles.endValue} dx={6}>
                  {valueFormat(label.value)}
                </tspan>
              </text>
            </g>
          ))}
          {active !== null && (
            <g>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={MARGIN.top}
                y2={MARGIN.top + plotH}
                className={styles.crosshair}
              />
              {series.map((item) => {
                const value = item.values[active];
                if (value === null) return null;
                return (
                  <circle
                    key={item.id}
                    cx={x(active)}
                    cy={y(value)}
                    r={4}
                    fill={item.color}
                    className={styles.dot}
                  />
                );
              })}
            </g>
          )}
        </svg>
      )}
      {active !== null && width > 0 && (
        <div
          className={styles.tooltip}
          style={{
            left: flip ? undefined : tooltipLeft + 12,
            right: flip ? width - tooltipLeft + 12 : undefined,
            top: MARGIN.top,
          }}
        >
          <div className={styles.tooltipTitle}>{xLabel(active)}</div>
          {series.map((item) => {
            const value = item.values[active];
            return (
              <div key={item.id} className={styles.tooltipRow}>
                <span className={styles.tooltipKey} style={{ background: item.color }} />
                <span className={styles.tooltipValue}>
                  {value === null ? '–' : valueFormat(value)}
                </span>
                <span className={styles.tooltipLabel}>{item.label}</span>
              </div>
            );
          })}
          {extraRows?.(active).map((row) => (
            <div key={row.label} className={styles.tooltipRow}>
              <span className={styles.tooltipKeyBlank} />
              <span className={styles.tooltipValue}>{row.value}</span>
              <span className={styles.tooltipLabel}>{row.label}</span>
            </div>
          ))}
        </div>
      )}
      <table className={styles.srOnly}>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col" />
            {series.map((item) => (
              <th key={item.id} scope="col">
                {item.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: count }, (_, index) => (
            <tr key={index}>
              <th scope="row">{xLabel(index)}</th>
              {series.map((item) => {
                const value = item.values[index];
                return <td key={item.id}>{value === null ? '–' : valueFormat(value)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
