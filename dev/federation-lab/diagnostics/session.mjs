import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
import { formatMegabytes, purgeDiagnosticArtifacts } from './artifacts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function allocateBackendPorts(count = 3) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map(
        (server) => new Promise((resolveClose) => server.close(resolveClose)),
      ),
    );
  }
}

/**
 * Ports 3101-3103 are the lab's fixed edge ports; 3100 sits just below them
 * and outside the ephemeral range, so allocateBackendPorts can never hand it
 * out. Holding it for the whole session lets the kernel enforce a single
 * concurrent federation:test and release the lock even after a crash.
 */
const diagnosticSessionLockPort = 3100;

export async function acquireSessionLock(port = diagnosticSessionLockPort) {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return server;
}

export function workloadArguments(args) {
  // npm appends caller arguments after the package script; the last value wins.
  const resolved = new Map();
  for (const arg of args) resolved.set(arg.split('=')[0], arg);
  if (resolved.get('--seed') === '--seed=random') {
    resolved.set('--seed', `--seed=${randomInt(1, 0x1_0000_0000)}`);
  }
  return [...resolved.values()];
}

/** Forward warning/error records, including pretty-printed multiline details. */
export function forwardWarnings(stream, terminal) {
  let warningRecord = false;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const plain = stripVTControlCharacters(line);
    let level;
    try {
      level = JSON.parse(plain)?.level;
    } catch {
      level = plain
        .match(/^\[[^\]]+\]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/i)?.[1]
        ?.toLowerCase();
    }
    if (level !== undefined) {
      warningRecord =
        typeof level === 'number'
          ? level >= 40
          : ['warn', 'error', 'fatal'].includes(level);
    } else if (!/^\s/.test(plain)) {
      warningRecord = false;
    }
    if (warningRecord) terminal.write(line + '\n');
  });
  return lines;
}

/** Each owned process tree has its own group, so cleanup cannot stop an existing lab. */
export function startProcess(
  command,
  args,
  { cwd, env, logPath, echo = 'warnings' },
) {
  const output = createWriteStream(logPath, { mode: 0o600 });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (echo === 'warnings') forwardWarnings(child.stdout, process.stdout);
  const tails = new Map();
  let failure;
  let finished = false;
  const listeners = new Set();
  output.on('error', (error) => {
    failure = error;
    child.kill('SIGTERM');
  });
  for (const [stream, terminal] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.on('data', (chunk) => {
      output.write(chunk);
      if (echo === true || (echo === 'warnings' && stream === child.stderr)) {
        terminal.write(chunk);
      }
      tails.set(
        stream,
        ((tails.get(stream) ?? '') + chunk.toString()).slice(-1024 * 1024),
      );
      for (const notify of listeners) notify();
    });
  }
  const done = new Promise((resolveDone) => {
    const finish = (code, signal, error) => {
      if (finished) return;
      finished = true;
      failure ??= error;
      output.end(() => resolveDone({ code, signal, error: failure }));
      for (const notify of listeners) notify();
    };
    child.once('error', (error) => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
  });
  return {
    done,
    async ready(marker, timeoutMs = 120000) {
      await new Promise((resolveReady, reject) => {
        const check = () => {
          if ([...tails.values()].some((tail) => tail.includes(marker))) {
            cleanup();
            resolveReady();
          } else if (finished) {
            cleanup();
            reject(
              failure ??
                new Error(
                  `process exited before readiness; inspect ${logPath}`,
                ),
            );
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`readiness timed out; inspect ${logPath}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          listeners.delete(check);
        };
        listeners.add(check);
        check();
      });
    },
    async stop(timeoutMs = 65000) {
      const signal = (name) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, name);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      signal('SIGTERM');
      let timer;
      const exited = await Promise.race([
        done.then(() => true),
        new Promise((resolveWait) => {
          timer = setTimeout(() => resolveWait(false), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) {
        signal('SIGKILL');
        await done;
      }
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Usage: npm run federation:test -- [--seed=<integer|random>]\nRequires npm run build:be first. Allows one session at a time: startup purges leftover diagnostic databases and run directories from previous sessions without touching the interactive dev lab, then starts three built backends with diagnostics, runs the workload, and stops owned processes. Workload parameters are configured in package.json.',
    );
    return;
  }
  let lock;
  try {
    lock = await acquireSessionLock(diagnosticSessionLockPort);
  } catch (error) {
    if (error?.code === 'EADDRINUSE')
      throw new Error(
        `another federation:test session is already running; stop it before starting a new one (session lock port ${diagnosticSessionLockPort})`,
      );
    throw error;
  }
  lock.unref();
  const directory = resolve(
    process.env.SOMS_DIAGNOSTICS_DIR ||
      join(
        root,
        'dev/federation-lab/diagnostic-runs',
        new Date().toISOString().replaceAll(/[-:.TZ]/g, ''),
      ),
  );
  const controlDirectory = join(directory, 'lab-control');
  const databasePrefix = `soms_fed_diag_${new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')}`;
  const backendPorts = await allocateBackendPorts();
  const env = {
    ...process.env,
    SOMS_DIAGNOSTICS_DIR: directory,
    FED_LAB_CONTROL_DIR: controlDirectory,
    FED_LAB_BACKEND_PORTS: JSON.stringify(backendPorts),
    FED_LAB_DATABASE_PREFIX: databasePrefix,
    FED_LAB_RUNTIME_DIR: join(directory, 'runtime'),
    FED_LAB_LOG_LEVEL: process.env.FED_LAB_LOG_LEVEL ?? 'info',
  };
  process.env.FED_LAB_BACKEND_PORTS = env.FED_LAB_BACKEND_PORTS;
  process.env.FED_LAB_DATABASE_PREFIX = env.FED_LAB_DATABASE_PREFIX;
  const { federationLabNodes } = await import('../topology.mjs');
  console.log(
    '[diagnostics] purging leftover artifacts from previous diagnostic sessions',
  );
  const purged = await purgeDiagnosticArtifacts({
    baseDatabaseUrl: process.env.DATABASE_URL,
    nodeNames: federationLabNodes.map((node) => node.name),
  });
  console.log(
    `[diagnostics] dropped ${purged.dropped} leftover diagnostic database(s), freeing ${formatMegabytes(purged.freedBytes)}` +
      (purged.kept > 0
        ? `; kept ${purged.kept} similarly named database(s) with an unexpected name shape`
        : ''),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(controlDirectory, 'requests'), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(controlDirectory, 'responses'), {
    recursive: true,
    mode: 0o700,
  });
  const owned = [];
  const controller = new AbortController();
  const interrupted = new Promise((_, reject) =>
    controller.signal.addEventListener(
      'abort',
      () => reject(controller.signal.reason),
      { once: true },
    ),
  );
  interrupted.catch(() => {});
  const onSignal = () =>
    controller.abort(new Error('diagnostic session interrupted'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const launch = (label, command, argv, echo = 'warnings') => {
    const process = startProcess(command, argv, {
      cwd: root,
      env,
      logPath: join(directory, `${label}.log`),
      echo,
    });
    owned.push(process);
    return process;
  };
  const guard = (promise) => Promise.race([promise, interrupted]);
  const manifest = {
    startedAt: new Date().toISOString(),
    arguments: workloadArguments(args),
    databasePrefix,
    databases: federationLabNodes.map(({ name, database }) => ({
      node: name,
      database,
    })),
    backendPorts,
    status: 'RUNNING',
    error: null,
  };
  const save = () =>
    writeFile(
      join(directory, 'session.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { mode: 0o600 },
    );
  console.log(`[diagnostics] all diagnostic files: ${directory}`);
  console.log(
    `[diagnostics] allocated backend ports: ${backendPorts.join(', ')}`,
  );
  await save();
  try {
    for (const node of federationLabNodes) {
      const running = await fetch(
        `${node.backendBaseUrl}/api/v1/client/compat`,
        {
          signal: AbortSignal.timeout(1000),
        },
      ).then(
        () => true,
        () => false,
      );
      if (running)
        throw new Error(
          `${node.name} is already running; stop the existing lab backends before running federation:test`,
        );
    }
    for (const output of ['dist/src/main.js', 'dist/scripts/migrate-db.js']) {
      await access(join(root, output)).catch(() => {
        throw new Error(`${output} is missing; run npm run build:be first`);
      });
    }
    console.log('[diagnostics] starting database collector and three backends');
    const collector = launch('collector', process.execPath, [
      'dev/federation-lab/diagnostics/collect.mjs',
    ]);
    const backend = launch('backend', process.execPath, [
      'dev/federation-lab/lab.mjs',
      '--backend-only',
    ]);
    for (const [label, child] of [
      ['collector', collector],
      ['backend', backend],
    ])
      child.done.then(() =>
        controller.abort(
          new Error(
            `${label} exited before the workload finished; inspect ${label}.log`,
          ),
        ),
      );
    await guard(
      Promise.all([
        collector.ready('[diagnostics] collecting into'),
        backend.ready('Three-node federation backends are ready:'),
      ]),
    );
    console.log('[diagnostics] starting workload');
    const workload = launch(
      'workload',
      process.execPath,
      [
        '--import',
        './dev/federation-lab/diagnostics/preload.mjs',
        'dev/federation-lab/p2p/run.mjs',
        ...manifest.arguments,
      ],
      true,
    );
    const result = await guard(workload.done);
    if (result.code !== 0)
      throw new Error(
        'workload failed; inspect workload.log and the reported run artifacts',
      );
    manifest.status = 'SUCCEEDED';
  } catch (error) {
    manifest.status = 'FAILED';
    manifest.error = error.message;
    process.exitCode = 1;
    console.error(`[diagnostics] ${error.message}`);
  } finally {
    console.log(
      '[diagnostics] stopping owned processes; graceful shutdown may take up to 65 seconds',
    );
    await Promise.all(owned.reverse().map((child) => child.stop()));
    await new Promise((releaseLock) => lock.close(releaseLock));
    manifest.finishedAt = new Date().toISOString();
    await save();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    console.log(`[diagnostics] ${manifest.status}; saved to ${directory}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`[diagnostics] ${error.message}`);
    process.exitCode = 1;
  });
