import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot } from './browser-runtime.mjs';
import { playgroundOrigin } from './targets.mjs';

export async function assertPortAvailable(port, host = '127.0.0.1') {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', () =>
      reject(
        new Error(
          `Port ${host}:${port} is occupied; refusing to reuse or stop an unknown server.`,
        ),
      ),
    );
    probe.listen(port, host, () => probe.close(resolve));
  });
}

/** Owned by the playground worker only; federation services are never started or stopped here. */
export async function startPlaygroundServer(logPath, timeoutMs = 180_000) {
  await assertPortAvailable(Number(new URL(playgroundOrigin).port));
  const log = await open(logPath, 'w', 0o600);
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      '--prefix',
      'web',
      'run',
      'start:playground',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      new URL(playgroundOrigin).port,
      '--no-hmr',
      '--no-live-reload',
      '--watch=false',
    ],
    {
      cwd: repositoryRoot,
      detached: process.platform !== 'win32',
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  let exited = false;
  let failure;
  child.once('error', (error) => {
    failure = error;
    exited = true;
  });
  const exit = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      failure = new Error(
        `Playground server exited (${code ?? signal}); inspect ${logPath}`,
      );
      exited = true;
      resolve();
    }),
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    try {
      kill('SIGTERM');
      await Promise.race([exit, delay(5_000)]);
      // The process group may still contain descendants after npm exits.
      kill('SIGKILL');
    } finally {
      await log.close();
    }
  };
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) throw failure;
      try {
        const response = await fetch(playgroundOrigin, {
          signal: AbortSignal.timeout(1_000),
        });
        await response.body?.cancel();
        if (response.ok) return stop;
      } catch {
        /* The owned server may still be compiling. */
      }
      await delay(200);
    }
    throw new Error(`Playground startup timed out; inspect ${logPath}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
