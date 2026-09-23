import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import readline from 'node:readline';

const separator = process.argv.indexOf('--');
if (separator < 0) {
  throw new Error(
    'usage: hmr-observer.mjs <service> <status-dir> -- <command> [args...]',
  );
}
const [service, statusDirectory] = process.argv.slice(2, separator);
const [command, ...args] = process.argv.slice(separator + 1);
if (!service || !statusDirectory || !command) {
  throw new Error('service, status directory, and command are required');
}

const directory = resolve(statusDirectory);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const statusPath = join(directory, `${service}.json`);
let buildId = 0;
let startedAt = new Date().toISOString();
let diagnostics = [];
let child;
let lastState = 'booting';
const sessionId = process.env.SOMS_HMR_SESSION_ID || null;
// A temporary-directory cleaner can remove the status directory while Angular keeps
// serving. A missing record is not evidence of a successful build; wait for the
// next real build event instead of recreating a success record from memory.
const statusHeartbeat = setInterval(() => {
  if (!existsSync(statusPath)) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeStatus('building');
    } catch (error) {
      console.error('[hmr-observer] status recovery failed', error);
    }
  }
}, 2_000);
statusHeartbeat.unref();

function writeStatus(state, extra = {}) {
  const value = {
    service,
    state,
    sessionId,
    buildId,
    observerPid: process.pid,
    childPid: child?.pid ?? null,
    pid: child?.pid ?? null,
    startedAt,
    updatedAt: new Date().toISOString(),
    diagnostics: diagnostics.slice(-40),
    ...extra,
  };
  lastState = state;
  const temporaryPath = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(temporaryPath, statusPath);
}

function beginBuild() {
  buildId += 1;
  startedAt = new Date().toISOString();
  diagnostics = [];
  writeStatus('building');
}

function observe(line) {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
  if (
    /Changes detected\. Rebuilding|Building\.\.\.|Application bundle generation started/i.test(
      plain,
    )
  ) {
    beginBuild();
  }
  if (/Application bundle generation complete/i.test(plain)) {
    writeStatus('success', { finishedAt: new Date().toISOString() });
  }
  if (/\bready in \d+(?:\.\d+)?\s*m?s\b/i.test(plain)) {
    writeStatus('success', { finishedAt: new Date().toISOString() });
  }
  if (/Application bundle generation failed/i.test(plain)) {
    writeStatus('failure', { finishedAt: new Date().toISOString() });
  }
  if (/\[ERROR\]|Error:|TS\d{4}:/.test(plain)) {
    diagnostics.push(plain.slice(0, 2_000));
  }
}

beginBuild();
child = spawn(command, args, {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
});
writeStatus('building');

for (const [stream, output] of [
  [child.stdout, process.stdout],
  [child.stderr, process.stderr],
]) {
  const lines = readline.createInterface({ input: stream });
  lines.on('line', (line) => {
    output.write(`${line}\n`);
    observe(line);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  diagnostics.push(error.message);
  writeStatus('failure', { finishedAt: new Date().toISOString() });
});
child.once('exit', (code, signal) => {
  clearInterval(statusHeartbeat);
  if (code !== 0 || lastState === 'building' || lastState === 'booting') {
    diagnostics.push(`dev server exited (${signal ?? code})`);
    writeStatus('failure', { finishedAt: new Date().toISOString() });
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
