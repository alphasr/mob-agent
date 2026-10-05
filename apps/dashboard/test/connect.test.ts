import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPool } from '../src/db/connect.ts';

describe('createPool', () => {
  it('survives the server dropping an idle connection instead of crashing the process', async () => {
    const pool = createPool('postgres://user@127.0.0.1:1/none'); // never connects
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => logged.push(args.join(' '));
    try {
      assert.doesNotThrow(() => pool.emit('error', new Error('Connection terminated unexpectedly')));
    } finally {
      console.error = original;
      await pool.end();
    }
    assert.deepEqual(logged, ['Postgres connection lost: Connection terminated unexpectedly']);
  });
});
