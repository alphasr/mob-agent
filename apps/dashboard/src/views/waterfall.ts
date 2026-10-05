import type { ExportedSpan } from '@textagent/cloud';

/** Geometry for the span waterfall, as fractions of the plot width; pure, so it is unit-tested. */

export interface WaterfallRow {
  span: ExportedSpan;
  /** Nesting under its parent span; 0 for top-level spans. */
  depth: number;
  /** Start and end, 0..1 of the axis. */
  x0: number;
  x1: number;
}

/**
 * Rows in tree order: each span right after its parent, siblings by start time. `parent` ids come from
 * agents, so a missing parent (a dropped span) makes a top-level span, and a parent cycle can't hide spans.
 */
export function layoutWaterfall(spans: ExportedSpan[], axisMaxMs: number): WaterfallRow[] {
  const ids = new Set(spans.map((s) => s.id));
  const children = new Map<string | undefined, ExportedSpan[]>();
  for (const span of spans) {
    const parent = span.parent !== undefined && ids.has(span.parent) ? span.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), span]);
  }
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);

  const rows: WaterfallRow[] = [];
  const placed = new Set<string>();
  const scale = (ms: number) => (axisMaxMs > 0 ? Math.min(Math.max(ms / axisMaxMs, 0), 1) : 0);
  const visit = (span: ExportedSpan, depth: number) => {
    if (placed.has(span.id)) return;
    placed.add(span.id);
    rows.push({ span, depth, x0: scale(span.startMs), x1: scale(span.startMs + span.durationMs) });
    for (const child of children.get(span.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(undefined) ?? []) visit(root, 0);
  // Spans whose parents only point at each other never hang off a root; show them at the top level.
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) visit(span, 0);
  return rows;
}

/** The axis must reach the turn's end and every span's end (an unfinished span can outlast its turn). */
export function axisMax(turnDurationMs: number, spans: ExportedSpan[]): number {
  return Math.max(turnDurationMs, ...spans.map((s) => s.startMs + s.durationMs), 1);
}
