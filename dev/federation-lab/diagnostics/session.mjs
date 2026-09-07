import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { federationLabNodes } from '../topology.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
        ((tails.get(stream) ?? '') + chunk.toString()).slice(-8192),
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
      'Usage: npm run federation:test -- [--seed=<integer|random>]\nRequires npm run build:be first. Resets lab databases and runtime, starts three built backends with diagnostics, runs the workload, then stops owned processes. Stop existing lab backends first. Workload parameters are configured in package.json.',
    );
    return;
  }
  const directory = resolve(
    process.env.SOMS_DIAGNOSTICS_DIR ||
      join(
        root,
        'dev/federation-lab/diagnostic-runs',
        new Date().toISOString().replaceAll(/[-:.TZ]/g, ''),
      ),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    SOMS_DIAGNOSTICS_DIR: directory,
    FED_LAB_LOG_LEVEL: process.env.FED_LAB_LOG_LEVEL ?? 'info',
  };
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
  await save();
  try {
    for (const node of federationLabNodes) {
      const running = await fetch(`${node.backendBaseUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      }).then(
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
    console.log('[diagnostics] resetting lab databases and runtime');
    const reset = await guard(
      launch('reset', process.execPath, ['dev/federation-lab/reset.mjs']).done,
    );
    if (reset.code !== 0)
      throw new Error('lab reset failed; inspect reset.log');
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
