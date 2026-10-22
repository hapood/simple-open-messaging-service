import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import {
  acquireSessionLock,
  forwardWarnings,
  startProcess,
  workloadArguments,
} from './session.mjs';

test('the session lock refuses a second holder on the same port', async () => {
  const lock = await acquireSessionLock(0);
  const port = lock.address().port;
  await assert.rejects(acquireSessionLock(port), (error) => error.code === 'EADDRINUSE');
  await new Promise((release) => lock.close(release));
  const rebound = await acquireSessionLock(port);
  await new Promise((release) => rebound.close(release));
});

test('resolves random seeds for replay and preserves package workload settings', () => {
  const args = ['--seed=random', '--operations=600', '--prefix=p2p'];
  const result = workloadArguments(args);
  const seed = Number(
    result.find((arg) => arg.startsWith('--seed=')).split('=')[1],
  );
  assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 0xffffffff);
  assert.deepEqual(result.slice(1), args.slice(1));
  assert.deepEqual(workloadArguments(result), result);
  assert.deepEqual(workloadArguments([]), []);
});

test('appended seed overrides the package random seed without duplicate options', () => {
  assert.deepEqual(
    workloadArguments(['--seed=random', '--operations=600', '--seed=12']),
    ['--seed=12', '--operations=600'],
  );
});

test('waits for readiness across chunks, preserves stdout/stderr, and stops the owned child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-session-'));
  const child = startProcess(
    process.execPath,
    [
      '-e',
      `
    process.stdout.write('REA');
    setTimeout(() => process.stdout.write('DY\\n'), 20);
    process.stderr.write('diagnostic detail\\n');
    process.on('SIGTERM', () => { console.log('stopped'); process.exit(0); });
    setInterval(() => {}, 1000);
  `,
    ],
    { cwd: directory, env: process.env, logPath: join(directory, 'child.log') },
  );
  try {
    await child.ready('READY', 3000);
    await child.stop(1000);
    assert.equal((await child.done).code, 0);
    const log = await readFile(join(directory, 'child.log'), 'utf8');
    assert.match(log, /diagnostic detail/);
    assert.match(log, /stopped/);
  } finally {
    await child.stop(1000);
    await rm(directory, { recursive: true, force: true });
  }
});

test('retains an early readiness marker across verbose startup output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-session-'));
  const child = startProcess(
    process.execPath,
    [
      '-e',
      "console.log('READY'); process.stdout.write('x'.repeat(64 * 1024)); setInterval(() => {}, 1000)",
    ],
    { cwd: directory, env: process.env, logPath: join(directory, 'child.log') },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await child.ready('READY', 3000);
  } finally {
    await child.stop(1000);
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports startup failure and force-stops an unresponsive owned process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-session-'));
  const failed = startProcess(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: directory,
    env: process.env,
    logPath: join(directory, 'failed.log'),
  });
  let stuck;
  try {
    await assert.rejects(
      failed.ready('READY', 3000),
      /exited before readiness/,
    );
    assert.equal((await failed.done).code, 7);
    stuck = startProcess(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)",
      ],
      {
        cwd: directory,
        env: process.env,
        logPath: join(directory, 'stuck.log'),
      },
    );
    await stuck.ready('READY', 3000);
    await stuck.stop(50);
    assert.equal((await stuck.done).signal, 'SIGKILL');
  } finally {
    if (stuck) await stuck.stop(50);
    await rm(directory, { recursive: true, force: true });
  }
});

test('forwards warning/error records across chunks with multiline details and UTF-8', async () => {
  const stream = new PassThrough();
  let output = '';
  const lines = forwardWarnings(stream, {
    write: (chunk) => {
      output += chunk;
    },
  });
  const closed = once(lines, 'close');
  const records = [
    '{"level":"info","msg":"error is just message text"}',
    '{"level":"warn","msg":"警告"}',
    '{"level":50,"msg":"failed"}',
    '\x1b[33m[2026-09-07 12:00:00.000] WARN\x1b[39m: retrying',
    '    context: "worker"',
    '[2026-09-07 12:00:01.000] INFO: healthy',
    '    context: "hidden"',
    '[2026-09-07 12:00:02.000] ERROR: failed',
    '    Error: connection failed',
    '        at worker (worker.mjs:1:1)',
    'ordinary launcher output',
    '{"level":"fatal","msg":"last record without newline"}',
  ];
  const bytes = Buffer.from(records.join('\n'));
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  await closed;
  assert.equal(
    output,
    [1, 2, 3, 4, 7, 8, 9, 11].map((index) => records[index] + '\n').join(''),
  );
});
