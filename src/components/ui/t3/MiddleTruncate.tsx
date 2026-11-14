/**
 * Ported from T3 Code (apps/web/src/components/ui/middle-truncate.tsx), MIT licensed,
 * Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
 *
 * Truncates in the middle so the distinguishing end of a long value (an email domain,
 * a file suffix, a request id) stays visible; the full value is in the title tooltip.
 */
import { type ComponentProps, useLayoutEffect, useRef } from 'react';
import styles from './MiddleTruncate.module.scss';

const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;
const MIN_WORD_TAIL = 4;
const WORD_BREAK = /[-_./@]/;

function splitForMiddleTruncate(
  value: string,
  tail?: number
): { head: string; tail: string } | null {
  // Split by code point to avoid cutting surrogate pairs into broken glyphs.
  const chars = Array.from(value);
  let keep = tail ?? DEFAULT_TAIL;
  if (tail === undefined) {
    const slash = chars.lastIndexOf('/');
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1;
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
    }
  }
  if (keep <= 0 || chars.length <= keep + 4) return null;
  let cut = chars.length - keep;
  // Start an automatic tail on a word ("machine", not "er-machine").
  if (tail === undefined && !WORD_BREAK.test(chars[cut - 1] ?? '')) {
    const startsWord = (index: number) => WORD_BREAK.test(chars[index - 1] ?? '');
    let snapped = -1;
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) {
        snapped = index;
        break;
      }
    }
    for (
      let index = cut - 1;
      snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4;
      index--
    ) {
      if (startsWord(index)) snapped = index;
    }
    if (snapped > 0) cut = snapped;
  }
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') };
}

// The segments render pre so the space at the cut survives; collapse what CSS would.
function collapseSegments(split: { head: string; tail: string }) {
  const collapse = (text: string) => text.replace(/[ \t\n\r\f]+/g, ' ');
  const head = collapse(split.head).replace(/^ /, '');
  const tail = collapse(split.tail).replace(/ $/, '');
  return { head, tail: head.endsWith(' ') ? tail.replace(/^ /, '') : tail };
}

// An overflowing head is cut after its last whole character: clip the partial glyph and
// slide the tail left over the slack. Neither changes layout.
function fitHead(head: HTMLElement) {
  const text = head.firstChild;
  const overflowing = head.scrollWidth > head.clientWidth && text instanceof Text;
  head.toggleAttribute('data-overflow', overflowing);
  let slack = 0;
  if (overflowing) {
    const range = document.createRange();
    const left = head.getBoundingClientRect().left;
    const widthTo = (end: number) => {
      range.setStart(text, 0);
      range.setEnd(text, end);
      return range.getBoundingClientRect().right - left;
    };
    let fits = 0;
    let over = text.length;
    while (over - fits > 1) {
      const mid = (fits + over) >> 1;
      if (widthTo(mid) <= head.clientWidth) fits = mid;
      else over = mid;
    }
    if (/[\uD800-\uDBFF]/.test(text.data[fits - 1] ?? '')) fits -= 1;
    slack = Math.max(0, head.clientWidth - widthTo(fits));
  }
  head.style.clipPath = slack > 0 ? `inset(-0.25em ${slack}px -0.25em 0)` : '';
  const tail = head.nextElementSibling;
  if (tail instanceof HTMLElement) tail.style.translate = slack > 0 ? `-${slack}px 0` : '';
}

export function MiddleTruncate({
  value,
  tail,
  showTitle = true,
  className,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> & {
  value: string;
  tail?: number;
  showTitle?: boolean;
}) {
  const raw = splitForMiddleTruncate(value, tail);
  const split = raw && collapseSegments(raw);
  const headRef = useRef<HTMLSpanElement>(null);
  const head = split?.head;

  useLayoutEffect(() => {
    const element = headRef.current;
    if (!element || head === undefined) return;
    fitHead(element);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitHead(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [head]);

  return (
    <span
      {...(showTitle ? { title: value } : {})}
      className={[styles.root, className].filter(Boolean).join(' ')}
      {...props}
    >
      {split ? (
        <>
          <span ref={headRef} className={styles.head}>
            {split.head}
          </span>
          <span className={styles.tail}>{split.tail}</span>
        </>
      ) : (
        <span key="whole" className={styles.whole}>
          {value}
        </span>
      )}
    </span>
  );
}
