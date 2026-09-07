import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProgressLogger } from './progress-log.mjs';
import { waitForTaskQueueIdle } from './execute.mjs';

test('retains drain diagnostics and terminal errors without a shutdown flush', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'p2p-progress-'));
  const printed = [];
  const logger = createProgressLogger(directory, {
    log: (message) => printed.push(message),
    error: (message) => printed.push(message),
  });
  try {
    await waitForTaskQueueIdle({
      actors: {
        node: () => ({
          admin: {
            durableTaskActivity: async () => ({
              pendingCount: 0,
              processing: [],
              asyncProcessing: [],
              queryMs: {
                PENDING: 2,
                PROCESSING: 3,
                ASYNC_PROCESSING: 4,
                FAILED: 5,
              },
            }),
          },
        }),
      },
      nodeNames: ['alpha'],
      description: 'midpoint-dissolution queue',
      timeoutMs: 3000,
      onProgress: logger.info,
    });
    logger.error('[p2p] task rejected');
    const records = readFileSync(join(directory, 'progress.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map(({ message }) => message),
      printed,
    );
    assert.ok(
      records.every(({ recordedAt }) =>
        Number.isFinite(Date.parse(recordedAt)),
      ),
    );
    assert.match(records[0].message, /midpoint-dissolution queue/);
    assert.match(records[0].message, /FAILED:5/);
    assert.match(records[1].message, /idleSamples=2\/2/);
    assert.match(records[1].message, /queryTotalMs=\d+ sleepTotalMs=\d+/);
    assert.equal(records[2].level, 'error');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
