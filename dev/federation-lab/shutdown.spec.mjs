import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { stopLabChildren } from './shutdown.mjs';

function child(pid, graceful) {
  const result = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    signals: [],
  });
  result.kill = (signal) => {
    result.signals.push(signal);
    if (graceful || signal === 'SIGKILL') {
      result.signalCode = signal;
      result.emit('exit', null, signal);
    }
  };
  return result;
}

test('returns immediately once all children exit without waiting for the deadline', async () => {
  const children = [child(1, true), child(2, true)];
  assert.equal(await stopLabChildren(children), true);
  assert.deepEqual(
    children.map((item) => item.signals),
    [['SIGTERM'], ['SIGTERM']],
  );
});

test('reports a forced shutdown and kills only surviving children', async () => {
  const children = [child(1, true), child(2, false)];
  let survivors;
  assert.equal(
    await stopLabChildren(children, {
      timeoutMs: 5,
      onTimeout: (value) => {
        survivors = value;
      },
    }),
    false,
  );
  assert.deepEqual(survivors, [children[1]]);
  assert.deepEqual(
    children.map((item) => item.signals),
    [['SIGTERM'], ['SIGTERM', 'SIGKILL']],
  );
});

test('does not signal an already exited child', async () => {
  const exited = child(1, false);
  exited.exitCode = 0;
  assert.equal(await stopLabChildren([exited]), true);
  assert.deepEqual(exited.signals, []);
});
