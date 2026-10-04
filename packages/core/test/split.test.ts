import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitText } from '../src/split.ts';

describe('splitText', () => {
  it('leaves short text alone', () => {
    assert.deepEqual(splitText('  hello  ', 100), ['hello']);
    assert.deepEqual(splitText('', 100), []);
  });

  it('prefers paragraph breaks', () => {
    const a = 'a'.repeat(30);
    const b = 'b'.repeat(30);
    assert.deepEqual(splitText(`${a}\n\n${b}`, 40), [a, b]);
  });

  it('ignores a break that would leave a tiny first chunk', () => {
    const chunks = splitText(`hi\n\n${'word '.repeat(20)}`, 40);
    assert.notEqual(chunks[0], 'hi');
    assert.ok(chunks.every((c) => c.length <= 40));
  });

  it('hard-cuts words longer than the limit without splitting emoji', () => {
    const text = 'a'.repeat(9) + '😀' + 'b'.repeat(5);
    const chunks = splitText(text, 10);
    assert.ok(chunks.every((c) => c.length <= 10));
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every((c) => !/[\ud800-\udbff]$/.test(c)), 'no chunk ends in a lone high surrogate');
  });

  it('never loses or exceeds on long prose', () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = splitText(text, 4096 / 32);
    assert.ok(chunks.every((c) => c.length <= 128));
    assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text);
  });

  it('rejects a non-positive limit', () => {
    assert.throws(() => splitText('x', 0), RangeError);
  });
});
