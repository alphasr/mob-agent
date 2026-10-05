'use client';

import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { formatCost, formatCostTick, formatCount, formatDuration } from '../../../src/views/format.ts';
import { band, columnPath, linePath, nearestIndex, niceTicks } from '../../../src/views/scale.ts';

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
  /** A CSS colour token: series slots for identity, `critical` only for failures. */
  color: 'series-1' | 'series-2' | 'critical';
}

const FORMATS = { count: formatCount, cost: formatCost, duration: formatDuration };

const WIDTH = 720;
const HEIGHT = 200;
const M = { top: 10, right: 80, bottom: 26, left: 64 };
const PLOT_W = WIDTH - M.left - M.right;
const PLOT_H = HEIGHT - M.top - M.bottom;
const GAP = 2; // surface gap between stacked segments

/**
 * A time-series chart: stacked columns or lines, one y-axis. Hover (or arrow keys when focused) snaps to a
 * bucket and lists every series there; the table below the chart holds the same numbers without hovering.
 */
export function TimeChart({
  title,
  starts,
  bucket,
  kind,
  series,
  format,
}: {
  title: string;
  /** UTC bucket starts, ms. */
  starts: number[];
  bucket: 'hour' | 'day';
  kind: 'columns' | 'lines';
  series: ChartSeries[];
  format: keyof typeof FORMATS;
}) {
  const [active, setActive] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const fmt = FORMATS[format];
  const count = starts.length;

  const totals = starts.map((_, i) =>
    kind === 'columns'
      ? series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)
      : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  );
  const ticks = niceTicks(Math.max(...totals, 0), 4);
  const yMax = ticks.at(-1) || 1;
  const y = (v: number) => M.top + PLOT_H - (v / yMax) * PLOT_H;
  const tickFmt = format === 'cost' ? (v: number) => formatCostTick(v, ticks[1] ?? yMax) : fmt;
  const labelEvery = Math.max(1, Math.ceil(count / 6));

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const box = svg.current!.getBoundingClientRect(); // set once mounted, and events only fire when mounted
    const x = ((event.clientX - box.left) / box.width) * WIDTH - M.left;
    setActive(x < 0 || x > PLOT_W ? null : nearestIndex(x, count, PLOT_W));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const from = active ?? count;
    setActive(Math.min(Math.max(from + (event.key === 'ArrowLeft' ? -1 : 1), 0), count - 1));
  };

  const lastPoint = (s: ChartSeries) => {
    for (let i = count - 1; i >= 0; i--) if (s.values[i] !== null) return { i, v: s.values[i]! };
    return undefined;
  };
  const ends = kind === 'lines' ? series.map(lastPoint) : [];
  // Direct end labels only when they can't collide; otherwise the legend carries identity.
  const endYs = ends.flatMap((e) => (e ? [y(e.v)] : []));
  const labelEnds = endYs.every((a, i) => endYs.every((b, j) => i === j || Math.abs(a - b) >= 14));

  return (
    <figure className="chart">
      <figcaption>
        <strong>{title}</strong>
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.name}>
                <svg width="14" height="10" aria-hidden="true">
                  {kind === 'lines' ? (
                    <line x1="0" x2="14" y1="5" y2="5" className={`stroke-${s.color}`} strokeWidth="2" />
                  ) : (
                    <rect width="10" height="10" rx="2" className={`fill-${s.color}`} />
                  )}
                </svg>
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-body">
        <svg
          ref={svg}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`${title}, ${count} ${bucket === 'hour' ? 'hours' : 'days'}; use arrow keys to read values`}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          {ticks.map((t) => (
            <g key={t} className="grid">
              <line x1={M.left} x2={M.left + PLOT_W} y1={y(t)} y2={y(t)} />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end">
                {tickFmt(t)}
              </text>
            </g>
          ))}
          {starts.map((start, i) =>
            i % labelEvery === 0 ? (
              <text
                key={start}
                className="axis"
                x={M.left + band(i, count, PLOT_W).center}
                y={HEIGHT - 8}
                textAnchor="middle"
              >
                {axisLabel(start, bucket)}
              </text>
            ) : null,
          )}
          <text className="axis" x={M.left + PLOT_W + 8} y={HEIGHT - 8}>
            UTC
          </text>

          {active !== null && kind === 'columns' && (
            <rect
              className="hover-band"
              x={M.left + (active * PLOT_W) / count}
              y={M.top}
              width={PLOT_W / count}
              height={PLOT_H}
            />
          )}

          {kind === 'columns' &&
            starts.map((start, i) => {
              const { x, barWidth } = band(i, count, PLOT_W);
              const segments: Array<{ s: ChartSeries; from: number; to: number }> = [];
              let total = 0;
              for (const s of series) {
                const v = s.values[i] ?? 0;
                if (v > 0) segments.push({ s, from: total, to: (total += v) });
              }
              return segments.map(({ s, from, to }, k) => (
                <path
                  key={`${start}-${s.name}`}
                  className={`fill-${s.color}`}
                  // A 2px surface gap separates stacked segments; only the top one gets rounded corners.
                  d={columnPath(
                    M.left + x,
                    y(to),
                    barWidth,
                    k === 0 ? y(from) : y(from) - GAP,
                    k === segments.length - 1 ? 4 : 0,
                  )}
                />
              ));
            })}

          {kind === 'lines' &&
            series.map((s) => (
              <path
                key={s.name}
                className={`line stroke-${s.color}`}
                d={linePath(
                  s.values.map((v, i) => ({ x: M.left + band(i, count, PLOT_W).center, y: v === null ? null : y(v) })),
                )}
              />
            ))}
          {kind === 'lines' &&
            labelEnds &&
            series.map((s, k) => {
              const end = ends[k];
              if (!end) return null;
              return (
                <text key={s.name} className="end-label" x={M.left + PLOT_W + 8} y={y(end.v) + 4}>
                  {s.name}
                </text>
              );
            })}

          {active !== null && kind === 'lines' && (
            <g className="crosshair">
              <line
                x1={M.left + band(active, count, PLOT_W).center}
                x2={M.left + band(active, count, PLOT_W).center}
                y1={M.top}
                y2={M.top + PLOT_H}
              />
              {series.map((s) =>
                s.values[active] === null ? null : (
                  <circle
                    key={s.name}
                    className={`fill-${s.color}`}
                    cx={M.left + band(active, count, PLOT_W).center}
                    cy={y(s.values[active]!)}
                    r={4}
                  />
                ),
              )}
            </g>
          )}
        </svg>

        {active !== null && (
          <div
            className="tooltip"
            role="status"
            style={{
              left: `${((M.left + band(active, count, PLOT_W).center) / WIDTH) * 100}%`,
              transform: active > count / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
            }}
          >
            <div className="muted">{localLabel(starts[active]!, bucket)}</div>
            {[...series].reverse().map((s) => (
              <div key={s.name}>
                <svg width="12" height="8" aria-hidden="true">
                  <line x1="0" x2="12" y1="4" y2="4" className={`stroke-${s.color}`} strokeWidth="2" />
                </svg>{' '}
                <strong>{s.values[active] === null ? '—' : fmt(s.values[active]!)}</strong>{' '}
                <span className="muted">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <details>
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>
              <th>{bucket === 'hour' ? 'Hour (UTC)' : 'Day (UTC)'}</th>
              {series.map((s) => (
                <th key={s.name} className="num">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {starts.map((start, i) => (
              <tr key={start}>
                <td>
                  {new Date(start)
                    .toISOString()
                    .slice(0, bucket === 'hour' ? 16 : 10)
                    .replace('T', ' ')}
                </td>
                {series.map((s) => (
                  <td key={s.name} className="num">
                    {s.values[i] === null ? '—' : fmt(s.values[i]!)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Axis labels in UTC, so the server's render and the browser's agree. */
function axisLabel(start: number, bucket: 'hour' | 'day'): string {
  const date = new Date(start);
  return bucket === 'hour'
    ? `${String(date.getUTCHours()).padStart(2, '0')}:00`
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The tooltip only exists after the page runs in the browser, so it can use the viewer's timezone. */
function localLabel(start: number, bucket: 'hour' | 'day'): string {
  const date = new Date(start);
  return bucket === 'hour'
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
