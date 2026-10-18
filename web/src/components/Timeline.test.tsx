// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXAMPLE_AS_OF,
  EXAMPLE_DUE_DATE,
  EXAMPLE_EVENTS,
  EXAMPLE_SEGMENTS,
} from '../content/example.ts';
import { Timeline } from './Timeline.tsx';

const NBSP = ' ';

afterEach(cleanup);

function renderExample() {
  return render(
    <Timeline
      due={EXAMPLE_DUE_DATE}
      today={EXAMPLE_AS_OF}
      segments={EXAMPLE_SEGMENTS}
      events={EXAMPLE_EVENTS}
    />,
  );
}

describe('Timeline', () => {
  it('renders the real list as text with an accessible label', () => {
    renderExample();
    const list = screen.getByRole('list', { name: 'Tramos de intereses' });
    expect(list.tagName).toBe('OL');
    const text = list.textContent;
    expect(text).toContain('13/09/2025 a 31/12/2025');
    expect(text).toContain(`110 días al 10,15${NBSP}%`);
    expect(text).toContain(`273,47${NBSP}€`);
    expect(text).toContain(`449,98${NBSP}€`);
    expect(text).toContain(`282,75${NBSP}€`);
    expect(text).toContain(`saldo 8.940,00${NBSP}€`);
    // Three segments plus the four milestones, in the same list.
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  });

  it('lets a custom label name the list', () => {
    render(
      <Timeline
        due={EXAMPLE_DUE_DATE}
        today={EXAMPLE_AS_OF}
        segments={EXAMPLE_SEGMENTS}
        events={EXAMPLE_EVENTS}
        listLabel="Desglose"
      />,
    );
    expect(screen.getByRole('list', { name: 'Desglose' })).toBeTruthy();
  });

  it('treats the chart as decorative', () => {
    const { container } = renderExample();
    const viz = container.querySelector('.tl-viz');
    expect(viz?.getAttribute('aria-hidden')).toBe('true');
    // Everything the chart says is also in the list, so nothing focusable lives inside it.
    expect(viz?.querySelector('a, button, [tabindex]')).toBeNull();
    expect(viz?.textContent).toContain(`1.006,20${NBSP}€`);
  });

  it('passes the dynamic values as CSS variables, not as HTML style strings', () => {
    const { container } = renderExample();
    const list = container.querySelector<HTMLElement>('.tl-list');
    expect(list?.style.getPropertyValue('--cols')).toBe('110fr 181fr 111fr');
    const segments = container.querySelectorAll<HTMLElement>('.seg');
    expect(segments).toHaveLength(3);
    expect(segments[0]?.style.getPropertyValue('--share')).toBe('0.2736');
    expect(segments[0]?.style.getPropertyValue('--bal')).toBe('1');
    const marks = container.querySelectorAll<HTMLElement>('.tl-mark');
    expect(marks).toHaveLength(4);
    expect(marks[0]?.style.insetInlineStart).toBe('0%');
  });

  it('shows the milestone labels with their dates and extra text', () => {
    const { container } = renderExample();
    const change = [...container.querySelectorAll('.tl-mark')].find((m) =>
      m.textContent.includes('Cambia el tipo'),
    );
    expect(change?.textContent).toContain('01/07/2026');
    expect(change?.textContent).toContain(`10,15${NBSP}% a 10,40${NBSP}%`);
  });

  it('marks a payment so the chart and the list can style it', () => {
    // Rendering only: these figures do not need to come from the interest engine.
    const { container } = render(
      <Timeline
        due="2025-09-12"
        today="2026-10-19"
        segments={[
          {
            start: '2025-09-13',
            end: '2026-04-15',
            days: 215,
            rateBp: 1015,
            balance: 894_000,
            interest: 53_451,
          },
          {
            start: '2026-04-16',
            end: '2026-10-19',
            days: 187,
            rateBp: 1015,
            balance: 694_000,
            interest: 36_616,
          },
        ]}
        events={[
          {
            date: '2026-04-15',
            label: 'Cobro',
            kind: 'payment',
            extra: '2.000,00 €',
          },
        ]}
      />,
    );
    expect(container.querySelector('.tl-mark.payment')).not.toBeNull();
    expect(container.querySelector('li.ev.payment')?.textContent).toBe(
      'Cobro el 15/04/2026, 2.000,00 €',
    );
  });
});
