import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

/** Bind-probe one address family; resolve true only when the port is taken. */
function probe(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) =>
      resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES'),
    );
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, host);
  });
}

async function portInUse(port) {
  return (await probe(port, '0.0.0.0')) || (await probe(port, '::'));
}

/** Best-effort holder lookup via ss(8); resolves empty when unavailable. */
function listeningPids(port) {
  return new Promise((resolve) => {
    const child = spawn('ss', ['-tlnp'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => resolve([]));
    child.once('exit', () => {
      const pids = new Set();
      for (const line of output.split('\n')) {
        if (!line.includes(`:${port} `)) continue;
        for (const match of line.matchAll(/pid=(\d+)/g)) {
          pids.add(Number(match[1]));
        }
      }
      resolve([...pids]);
    });
  });
}

async function processCommand(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').filter(Boolean).join(' ');
  } catch {
    return null;
  }
}

/**
 * Fail fast when the lab's ports are already bound — most likely by a leaked
 * dev server from a previous run — instead of letting each spawned service
 * crash on its own with an opaque bind error.
 */
export async function assertPortsFree(ports) {
  const busy = [];
  for (const port of [...new Set(ports)]) {
    if (!(await portInUse(port))) continue;
    const holders = [];
    for (const pid of await listeningPids(port)) {
      const command = await processCommand(pid);
      holders.push(command ? `pid ${pid} (${command})` : `pid ${pid}`);
    }
    busy.push({ port, holders: holders.join('; ') });
  }
  if (!busy.length) return;
  const detail = busy
    .map(({ port, holders }) =>
      holders
        ? `  port ${port} — held by ${holders}`
        : `  port ${port} — holder could not be identified`,
    )
    .join('\n');
  throw new Error(
    `[lab] refusing to start: port(s) already in use, likely a leaked previous lab run or another session:\n${detail}`,
  );
}
