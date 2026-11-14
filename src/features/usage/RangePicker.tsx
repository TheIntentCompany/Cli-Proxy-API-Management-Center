import { useEffect, useRef, useState } from 'react';
import { useNow } from '@/hooks/useNow';
import { useTranslation } from 'react-i18next';
import { RANGE_PRESETS, startOfLocalDay, type UsageRange } from './range';
import styles from './usage.module.scss';

const DAY = 86_400_000;

const toInput = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const fromInput = (value: string): number | null => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day).getTime();
};

/** 24 hours · 7 days · 30 days · All time · Custom, as one segmented control. */
export function RangePicker({
  range,
  onChange,
}: {
  range: UsageRange;
  onChange: (range: UsageRange) => void;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useNow();
  const [from, setFrom] = useState(() => toInput(range.customFrom ?? now - 6 * DAY));
  const [to, setTo] = useState(() => toInput(range.customTo ?? now));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const customLabel =
    range.id === 'custom' && range.customFrom && range.customTo
      ? `${new Date(range.customFrom).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })} – ${new Date(range.customTo - 1).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}`
      : t('usage.range_custom');

  const fromMs = fromInput(from);
  const toMs = fromInput(to);
  const valid = fromMs !== null && toMs !== null && fromMs <= toMs;

  return (
    <div className={styles.rangeRoot} ref={rootRef}>
      <div className={styles.segmented} role="group" aria-label={t('usage.range_label')}>
        {RANGE_PRESETS.map((id) => (
          <button
            key={id}
            type="button"
            className={range.id === id ? styles.segmentActive : styles.segment}
            aria-pressed={range.id === id}
            onClick={() => onChange({ id })}
          >
            {t(`usage.range_${id}`)}
          </button>
        ))}
        <button
          type="button"
          className={range.id === 'custom' ? styles.segmentActive : styles.segment}
          aria-pressed={range.id === 'custom'}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
        >
          {customLabel}
        </button>
      </div>
      {open && (
        <div className={styles.rangePopover} role="dialog" aria-label={t('usage.range_custom')}>
          <label>
            <span>{t('usage.range_from')}</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>{t('usage.range_to')}</span>
            <input
              type="date"
              value={to}
              min={from}
              max={toInput(now)}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!valid}
            onClick={() => {
              if (!valid || fromMs === null || toMs === null) return;
              // The end date is inclusive: the range runs to the end of that day.
              onChange({
                id: 'custom',
                customFrom: startOfLocalDay(fromMs),
                customTo: startOfLocalDay(toMs) + DAY,
              });
              setOpen(false);
            }}
          >
            {t('usage.range_apply')}
          </button>
        </div>
      )}
    </div>
  );
}
