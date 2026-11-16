import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LimitMeter } from '@/components/ui/LimitMeter';

const render = (usedPercent: number | null) =>
  renderToStaticMarkup(
    createElement(LimitMeter, {
      label: 'Weekly',
      usedPercent,
      color: 'red',
      emptyText: 'not reported',
      warningText: 'near limit',
      cappedText: 'capped',
    })
  );

describe('limit meter warning', () => {
  test('says nothing below 90%', () => {
    const html = render(89);
    expect(html).not.toContain('near limit');
    expect(html).not.toContain('capped');
  });

  test('says near limit while the shown figure is 90% to 99%', () => {
    for (const used of [90, 99, 99.4]) {
      const html = render(used);
      expect(html).toContain('near limit');
      expect(html).not.toContain('capped');
    }
  });

  test('says capped once the shown figure is 100%', () => {
    for (const used of [99.6, 100, 120]) {
      const html = render(used);
      expect(html).toContain('capped');
      expect(html).not.toContain('near limit');
    }
  });
});
