import type { CSSProperties } from 'react';
import {
  formatDate,
  formatDays,
  formatEUR,
  formatRate,
} from '../lib/format.ts';
import {
  buildTimeline,
  type TimelineEvent,
  type TimelineInput,
} from '../lib/timeline.ts';

interface TimelineProps extends TimelineInput {
  listLabel?: string;
}

// Only values that depend on the data go through `style` (React sets them with the CSSOM, which
// a strict style-src allows); every other rule lives in timeline.css.
const vars = (values: Record<`--${string}`, string | number>): CSSProperties =>
  values;

function eventText(event: TimelineEvent): string {
  const extra = event.extra ? `, ${event.extra}` : '';
  return `el ${formatDate(event.date)}${extra}`;
}

// The chart is decorative (aria-hidden); the ordered list below it carries the same facts as
// text and is what assistive technology reads. On wide containers the list shows one column per
// segment under the chart; on narrow ones it becomes the vertical timeline.
export function Timeline({
  listLabel = 'Tramos de intereses',
  ...input
}: TimelineProps) {
  const model = buildTimeline(input);
  return (
    <figure className="tl">
      <div className="tl-viz" aria-hidden="true">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
          <path className="tl-area" d={model.areaPath} />
          <path
            className="tl-line"
            d={model.curvePath}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="tl-axis" />
        {model.marks.map(({ event, position, align, key }) => (
          <div
            key={`${event.date}-${event.label}`}
            className={`tl-mark ${align} ${event.kind}${key ? ' key' : ''}`}
            style={{ insetInlineStart: `${String(position)}%` }}
          >
            <div className="lab">
              <b>{event.label}</b>
              <span>
                {formatDate(event.date)}
                {event.extra ? (
                  <>
                    <br />
                    {event.extra}
                  </>
                ) : null}
              </span>
            </div>
            <i className="dot" />
          </div>
        ))}
        <div className="tl-end">
          <small>intereses acumulados</small>
          <span className="amt">{formatEUR(model.totalInterest)}</span>
        </div>
      </div>
      <ol
        className="tl-list"
        aria-label={listLabel}
        style={vars({ '--cols': model.columns })}
      >
        {model.items.map((item) =>
          item.type === 'event' ? (
            <li key={item.id} className={`ev ${item.event.kind}`}>
              <b>{item.event.label}</b> {eventText(item.event)}
            </li>
          ) : (
            <li
              key={item.id}
              className={`seg${item.alt ? ' alt' : ''}`}
              style={vars({
                '--share': item.share,
                '--bal': item.balanceRatio,
              })}
            >
              <span className="when">
                {formatDate(item.segment.start)} a{' '}
                {formatDate(item.segment.end)}
              </span>
              <span className="rate">
                {formatDays(item.segment.days)} al{' '}
                {formatRate(item.segment.rateBp)}
              </span>
              <span className="bal">
                saldo {formatEUR(item.segment.balance)}
              </span>
              <span className="amt">{formatEUR(item.segment.interest)}</span>
            </li>
          ),
        )}
      </ol>
    </figure>
  );
}
