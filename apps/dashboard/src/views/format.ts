/** Display helpers shared by the pages; pure, so they are unit-tested. */

export const RANGES = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;

/** A range from the URL (untrusted); anything unknown is the default, 24h. */
export function parseRange(value: unknown): Range {
  return typeof value === 'string' && Object.hasOwn(RANGES, value) ? (value as Range) : '24h'; // checked against RANGES
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Estimates; four decimals because a single turn often costs a fraction of a cent. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Enough of a hashed id to tell conversations apart on screen. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** Axis ticks need only as many decimals as the step between them: $0.05, $0.10, not $0.0500, $0.1000. */
export function formatCostTick(usd: number, step: number): string {
  const decimals = step > 0 ? Math.min(Math.max(-Math.floor(Math.log10(step)), 0), 4) : 2;
  return `$${usd.toFixed(decimals)}`;
}
