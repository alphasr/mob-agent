import type { ExportedSpan } from '@textagent/cloud';
import { formatDuration } from '../../../../../src/views/format.ts';
import { niceTicks } from '../../../../../src/views/scale.ts';
import { axisMax, layoutWaterfall } from '../../../../../src/views/waterfall.ts';

const LABEL_WIDTH = 220;
const PLOT_WIDTH = 640;
const VALUE_ROOM = 70; // a duration label beside a bar needs about this much
const ROW_HEIGHT = 28;
const BAR_HEIGHT = 14;
const AXIS_HEIGHT = 24;
const FOOTER_HEIGHT = 20; // room for the end-of-turn label
const MAX_NAME = 30;

/**
 * Server-rendered SVG; every text node goes through React, so agent-supplied span names are escaped.
 * Hover shows each span's details via <title>; the spans table below repeats every value.
 */
export function Waterfall({ spans, turnDurationMs }: { spans: ExportedSpan[]; turnDurationMs: number }) {
  const max = axisMax(turnDurationMs, spans);
  const ticks = niceTicks(max);
  const axisEnd = ticks.at(-1)!; // niceTicks always returns at least [0]
  const rows = layoutWaterfall(spans, axisEnd);
  const x = (fraction: number) => LABEL_WIDTH + fraction * PLOT_WIDTH;
  const plotBottom = AXIS_HEIGHT + rows.length * ROW_HEIGHT;
  const height = plotBottom + FOOTER_HEIGHT;
  const turnEnd = x(Math.min(turnDurationMs / axisEnd, 1));

  return (
    <svg
      className="waterfall"
      viewBox={`0 0 ${LABEL_WIDTH + PLOT_WIDTH + 8} ${height}`}
      role="img"
      aria-label={`Timeline of ${rows.length} spans over ${formatDuration(max)}`}
    >
      {ticks.map((t) => (
        <g key={t} className="tick">
          <line x1={x(t / axisEnd)} x2={x(t / axisEnd)} y1={AXIS_HEIGHT - 6} y2={plotBottom} />
          <text x={x(t / axisEnd)} y={12} textAnchor={t === 0 ? 'start' : t === axisEnd ? 'end' : 'middle'}>
            {formatDuration(t)}
          </text>
        </g>
      ))}
      {/* Where the handler returned; spans past it were still running (unfinished). */}
      <g className="turn-end">
        <line x1={turnEnd} x2={turnEnd} y1={AXIS_HEIGHT - 6} y2={plotBottom + 4} />
        <text x={turnEnd} y={plotBottom + 16} textAnchor={turnEnd > x(0.9) ? 'end' : 'middle'}>
          end of turn · {formatDuration(turnDurationMs)}
        </text>
      </g>
      {rows.map(({ span, depth, x0, x1 }, i) => {
        const top = AXIS_HEIGHT + i * ROW_HEIGHT;
        const barY = top + (ROW_HEIGHT - BAR_HEIGHT) / 2;
        const width = Math.max((x1 - x0) * PLOT_WIDTH, 2);
        const name = span.name.length > MAX_NAME ? `${span.name.slice(0, MAX_NAME - 1)}…` : span.name;
        const status = span.error ? ' ✖ error' : span.unfinished ? ' · unfinished' : '';
        const value = `${formatDuration(span.durationMs)}${status}`;
        // Beside the bar's end if there is room, else before its start; the title and table always have it.
        const after = x(x0) + width + VALUE_ROOM <= x(1) + 8;
        const before = !after && x0 * PLOT_WIDTH >= VALUE_ROOM;
        return (
          <g key={span.id} className="row">
            <title>
              {`${span.name}: ${formatDuration(span.durationMs)} starting at ${formatDuration(span.startMs)}` +
                (span.error ? `, failed: ${span.error}` : '') +
                (span.unfinished ? ', still running when the turn ended' : '')}
            </title>
            <rect
              className="hit"
              x={0}
              y={top}
              width={LABEL_WIDTH + PLOT_WIDTH}
              height={ROW_HEIGHT}
              fill="transparent"
            />
            <text x={8 + depth * 12} y={top + ROW_HEIGHT / 2 + 4}>
              {name}
            </text>
            <rect
              className={`bar${span.error ? ' failed' : ''}${span.unfinished ? ' unfinished' : ''}`}
              x={x(x0)}
              y={barY}
              width={width}
              height={BAR_HEIGHT}
              rx={3}
            />
            {(after || before) && (
              <text
                className="value"
                x={after ? x(x0) + width + 6 : x(x0) - 6}
                y={top + ROW_HEIGHT / 2 + 4}
                textAnchor={after ? 'start' : 'end'}
              >
                {value}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
