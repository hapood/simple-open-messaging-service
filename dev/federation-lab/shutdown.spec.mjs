import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { signalProcessGroup, stopLabChildren } from './shutdown.mjs';

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

// Fake pids must never reach the default group killer: pid 1 would broadcast
// to every process group on the machine.
const record = (child, signal) => child.kill(signal);

test('returns immediately once all children exit without waiting for the deadline', async () => {
  const children = [child(1, true), child(2, true)];
  assert.equal(await stopLabChildren(children, { signal: record }), true);
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
      signal: record,
    }),
    false,
  );
  assert.deepEqual(survivors, [children[1]]);
  assert.deepEqual(
    children.map((item) => item.signals),
    [['SIGTERM'], ['SIGTERM', 'SIGKILL']],
  );
});

test('signals the group of an already exited child, whose grandchildren may outlive it', async () => {
  const exited = child(1, false);
  exited.exitCode = 0;
  assert.equal(await stopLabChildren([exited], { signal: record }), true);
  assert.deepEqual(exited.signals, ['SIGTERM']);
});

/** A detached bash that stays alive and reports its own and its grandchild's pid. */
function spawnTree() {
  const child = spawn('bash', ['-c', 'sleep 30 & echo $$ "$!"; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const pids = new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const [leader, grandchild] = buffer.split(/\s+/).filter(Boolean);
      if (leader && grandchild) {
        child.stdout.off('data', onData);
        resolve({ leader: Number(leader), grandchild: Number(grandchild) });
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
  return { child, pids };
}

/** Wait until the process is reaped or a zombie; fail if it is still running. */
async function assertProcessGone(pid, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2)[0];
      if (state === 'Z') return;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} is still alive`);
}

test('signals the whole process group, including grandchildren', async () => {
  const { child, pids } = await spawnTree();
  try {
    const { leader, grandchild } = await pids;
    signalProcessGroup(child, 'SIGKILL');
    await once(child, 'exit');
    await assertProcessGone(leader);
    await assertProcessGone(grandchild);
  } finally {
    signalProcessGroup(child, 'SIGKILL');
  }
});

test('still kills the group after its leader exited, reaching orphaned grandchildren', async () => {
  const { child, pids } = await spawnTree();
  try {
    const { leader, grandchild } = await pids;
    child.kill('SIGKILL'); // the leader dies alone, like npm ahead of vite
    await once(child, 'exit');
    await assertProcessGone(leader);
    signalProcessGroup(child, 'SIGKILL'); // the group still holds the grandchild
    await assertProcessGone(grandchild);
  } finally {
    signalProcessGroup(child, 'SIGKILL');
  }
});

test('tolerates signaling a group that is already gone', async () => {
  const child = spawn('true', [], { detached: true, stdio: 'ignore' });
  await once(child, 'exit');
  signalProcessGroup(child, 'SIGTERM'); // must not throw
});
