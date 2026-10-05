import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ExportedSpan } from '@textagent/cloud';
import { niceTicks } from '../src/views/scale.ts';
import { axisMax, layoutWaterfall } from '../src/views/waterfall.ts';

const span = (id: string, startMs: number, durationMs: number, parent?: string): ExportedSpan => ({
  id,
  name: id,
  startMs,
  durationMs,
  attributes: {},
  ...(parent && { parent }),
});

const shape = (spans: ExportedSpan[], max = 1000) =>
  layoutWaterfall(spans, max).map((r) => `${'  '.repeat(r.depth)}${r.span.id} ${r.x0}-${r.x1}`);

describe('layoutWaterfall', () => {
  it('puts children under their parent, siblings in start order, scaled to the axis', () => {
    const rows = shape([
      span('tool', 600, 100, 'claude'),
      span('claude', 100, 800),
      span('reply', 900, 100),
      span('think', 150, 300, 'claude'),
    ]);
    assert.deepEqual(rows, ['claude 0.1-0.9', '  think 0.15-0.45', '  tool 0.6-0.7', 'reply 0.9-1']);
  });

  it('shows spans with a missing parent at the top level instead of losing them', () => {
    assert.deepEqual(shape([span('orphan', 0, 500, 'dropped-span')]), ['orphan 0-0.5']);
  });

  it('shows every span of a parent cycle exactly once', () => {
    const rows = layoutWaterfall([span('a', 0, 10, 'b'), span('b', 5, 10, 'a'), span('c', 1, 1, 'c')], 100);
    assert.deepEqual(rows.map((r) => r.span.id).sort(), ['a', 'b', 'c']);
  });

  it('clamps to the axis and survives an empty or zero-length turn', () => {
    assert.deepEqual(shape([span('late', 900, 500)]), ['late 0.9-1']);
    assert.deepEqual(shape([span('x', 0, 0)], 0), ['x 0-0']);
    assert.deepEqual(layoutWaterfall([], 100), []);
  });
});

describe('axisMax', () => {
  it('reaches the turn end and the end of a span that outlasted it', () => {
    assert.equal(axisMax(1000, [span('a', 0, 400)]), 1000);
    assert.equal(axisMax(1000, [span('a', 900, 400)]), 1300);
    assert.equal(axisMax(0, []), 1);
  });
});

describe('niceTicks', () => {
  it('picks round steps that cover the range', () => {
    assert.deepEqual(niceTicks(1000), [0, 200, 400, 600, 800, 1000]);
    assert.deepEqual(niceTicks(840), [0, 200, 400, 600, 800, 1000]);
    assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
    assert.deepEqual(niceTicks(0.3), [0, 0.1, 0.2, 0.3]);
    assert.deepEqual(niceTicks(0), [0]);
  });
});
