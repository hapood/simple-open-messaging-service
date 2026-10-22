import 'dotenv/config';
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { prepareLabConfig } from './local-config.mjs';
import { ensureLabDatabase } from './database.mjs';
import { assertPortsFree } from './ports.mjs';
import { writeHmrSession } from './hmr-session.mjs';
import { signalProcessGroup, stopLabChildren } from './shutdown.mjs';
import {
  federationLabDatabaseUrl,
  federationLabNodes,
  federationLabRoutes,
} from './topology.mjs';

const labDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(labDir, '..', '..');
const runtimeDir = resolve(
  process.env.FED_LAB_RUNTIME_DIR || join(labDir, 'runtime'),
);
const options = new Set(process.argv.slice(2));
const devServer = options.delete('--dev-server');
const backendOnly = options.delete('--backend-only');
const frontendOnly = options.delete('--frontend-only');
const unknown = [...options];
if (unknown.length) throw new Error(`unknown option: ${unknown.join(' ')}`);
if (backendOnly && frontendOnly) {
  throw new Error('--backend-only and --frontend-only are mutually exclusive');
}
const runBackend = !frontendOnly;
const runFrontend = !backendOnly;
const webDevPort = 4200;
const adminDevPort = 5180;
const browserE2eRoot =
  process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
const hmrLogDir = join(browserE2eRoot, 'logs');
const hmrStatusDir = join(browserE2eRoot, 'status');
const hmrSessionId = new Date().toISOString();
let hmrRecoveryTimer;
let controlTimer;

function restoreHmrSessionMarker() {
  // Restore identity only; each frontend must publish a fresh successful build independently.
  writeHmrSession(hmrStatusDir, hmrSessionId, process.pid);
}

const baseDatabaseUrl = process.env.DATABASE_URL?.trim();
if (runBackend && !baseDatabaseUrl) {
  throw new Error('DATABASE_URL is required in the repository .env');
}

const nodes = federationLabNodes;

function databaseUrl(database) {
  return federationLabDatabaseUrl(baseDatabaseUrl, database);
}

const children = [];
const backendChildren = new Map();
const controlledBackendStops = new WeakSet();
let controlBusy = false;
let stopping = false;
let interrupted = false;
let finish;
const finished = new Promise((resolvePromise) => {
  finish = resolvePromise;
});
// Aborted by stop(). Every long-running boot step and readiness check observes
// this signal so an interrupt takes effect immediately instead of when each
// step reaches its own timeout.
const shutdown = new AbortController();

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  shutdown.abort();
  if (hmrRecoveryTimer) clearInterval(hmrRecoveryTimer);
  if (controlTimer) clearInterval(controlTimer);
  console.log(
    children.length
      ? '[lab] stopping children gracefully (up to 60s)'
      : '[lab] shutting down',
  );
  void stopLabChildren(children, {
    onTimeout: (survivors) =>
      console.warn(
        `[lab] shutdown grace period expired; forcing ${survivors.length} remaining children to exit`,
      ),
  })
    .then((graceful) => {
      if (!graceful) process.exitCode = 1;
      finish();
    })
    .catch((error) => {
      console.error('[lab] shutdown failed', error);
      process.exitCode = 1;
      finish();
    });
}

function onInterruptSignal(name) {
  if (stopping) {
    // A second press means "leave now": skip the grace period entirely.
    console.log(`[lab] second ${name}; killing children and exiting`);
    for (const child of children) signalProcessGroup(child, 'SIGKILL');
    process.exit(130);
  }
  interrupted = true;
  stop(0);
}

process.on('SIGINT', () => onInterruptSignal('SIGINT'));
process.on('SIGTERM', () => onInterruptSignal('SIGTERM'));

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      signal: shutdown.signal,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`),
        );
    });
  });
}

function sleep(ms, signal) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true },
    );
  });
}

async function prepareDatabase(database) {
  const admin = new URL(baseDatabaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  const onShutdown = () => client.end().catch(() => {});
  shutdown.signal.addEventListener('abort', onShutdown, { once: true });
  try {
    await client.connect();
    const created = await ensureLabDatabase(client, database);
    console.log(`[lab] ${created ? 'created' : 'reusing'} ${database}`);
  } finally {
    shutdown.signal.removeEventListener('abort', onShutdown);
    await client.end().catch(() => {});
  }
}

async function waitForUrl(url, signal, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = 'no response';
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error(`shutdown requested while waiting for ${url}`);
    }
    try {
      const response = await fetch(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
          : AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastResult = `HTTP ${response.status}`;
    } catch (error) {
      if (signal?.aborted) {
        throw new Error(`shutdown requested while waiting for ${url}`);
      }
      lastResult = error instanceof Error ? error.message : String(error);
    }
    await sleep(250, signal);
  }
  throw new Error(
    `${url} was not ready within ${timeoutMs / 1000} seconds (${lastResult})`,
  );
}

async function waitForServices(services, signal) {
  const statuses = Object.fromEntries(
    services.map(({ name }) => [name, 'waiting']),
  );
  const report = () => {
    console.log(
      `[lab] readiness: ${services.map(({ name }) => `${name}=${statuses[name]}`).join(' ')}`,
    );
  };
  const reporter = setInterval(report, 2_000);

  try {
    await Promise.all(
      services.map(async ({ name, check }) => {
        try {
          await check(signal);
          statuses[name] = 'ready';
        } catch (error) {
          statuses[name] = 'failed';
          throw error;
        }
      }),
    );
  } catch (error) {
    report();
    if (signal?.aborted) {
      // Interrupted, not failed: stop() is already draining the children and
      // the interrupt handler owns the exit code.
      await finished;
      return false;
    }
    console.error(
      `[lab] readiness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    stop(1);
    await finished;
    throw error;
  } finally {
    clearInterval(reporter);
  }

  report();
  console.log(
    `[lab] ${services.map(({ name }) => name).join(', ')} are ready.`,
  );
  return true;
}

const requiredOutputs = [];
if (runBackend) {
  requiredOutputs.push(
    join(root, 'dist', 'src', 'main.js'),
    join(root, 'dist', 'scripts', 'migrate-db.js'),
  );
}
if (runFrontend && !devServer) {
  requiredOutputs.push(
    join(root, 'web', 'dist', 'web', 'browser', 'index.html'),
    join(root, 'admin-web', 'dist', 'index.html'),
  );
}
if (requiredOutputs.some((output) => !existsSync(output))) {
  throw new Error('one or more required build outputs are missing');
}

const preflightPorts = [];
if (runBackend) preflightPorts.push(...nodes.map((node) => node.backendPort));
if (runFrontend) {
  preflightPorts.push(...nodes.map((node) => node.edgePort));
  if (devServer) preflightPorts.push(webDevPort, adminDevPort);
}
await assertPortsFree(preflightPorts);

const routes = federationLabRoutes;

function labEnvironment(node, peerRoutes) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(node.backendPort),
    SOMS_DOMAIN: node.domain,
    SOMS_TLS_MODE: 'disabled',
    SOMS_ALLOW_INSECURE_HTTP: '1',
    SOMS_DEV_FEDERATION_ROUTES: JSON.stringify(peerRoutes),
    DATABASE_URL: databaseUrl(node.database),
    SOMS_DATA_DIR: join(runtimeDir, node.name, 'data'),
    SOMS_CONFIG_DIR: join(labDir, 'local', node.name),
    LOG_DIR: join(runtimeDir, node.name, 'data', 'logs'),
    // Development defaults to compact execution summaries instead of printing every SQL statement.
    // Keep each value overridable for focused debugging and performance comparisons.
    LOG_LEVEL: process.env.FED_LAB_LOG_LEVEL ?? 'debug',
    DATABASE_QUERY_LOG: process.env.DATABASE_QUERY_LOG ?? '0',
    EXECUTION_MEASUREMENT_SAMPLE_RATE:
      process.env.EXECUTION_MEASUREMENT_SAMPLE_RATE ?? '1',
  };

  // Deployment-specific values from the repository .env must not change the
  // lab topology or enable direct TLS in its HTTP-only backend processes.
  for (const name of [
    'TLS_CERT',
    'TLS_KEY',
    'SOMS_WEB_DOMAIN',
    'SOMS_LAN_DOMAIN',
    'SOMS_WEBAUTHN_RP_ID',
    'SOMS_WEBAUTHN_ALLOWED_ORIGINS',
  ]) {
    delete env[name];
  }
  return env;
}

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    // Own process group, so shutdown reaches the whole subtree (npm → sh → vite).
    detached: true,
    ...options,
  });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[lab] ${command} ${args.join(' ')} exited (${signal ?? code})`,
      );
      stop(1);
    }
  });
  return child;
}

async function stopBackendChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  controlledBackendStops.add(child);
  const exited = new Promise((resolvePromise) =>
    child.once('exit', resolvePromise),
  );
  signalProcessGroup(child, 'SIGTERM');
  const timer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), 60_000);
  timer.unref();
  await exited;
  clearTimeout(timer);
}

function startBackendNode(node, domain = node.domain) {
  const peerRoutes = { ...routes };
  delete peerRoutes[node.domain];
  delete peerRoutes[node.transitionDomain];
  const diagnosticsArgs = process.env.SOMS_DIAGNOSTICS_DIR
    ? [
        '--import',
        join(root, 'dev', 'federation-lab', 'diagnostics', 'preload.mjs'),
      ]
    : [];
  const child = spawn(
    'node',
    [...diagnosticsArgs, join(root, 'dist', 'src', 'main.js')],
    {
      cwd: root,
      stdio: ['inherit', 'pipe', 'inherit'],
      env: labEnvironment({ ...node, domain }, peerRoutes),
      detached: true,
    },
  );
  const backendLog = createWriteStream(
    join(runtimeDir, node.name, 'backend.log'),
    { flags: 'a' },
  );
  child.stdout.pipe(backendLog);
  child.stdout.pipe(process.stdout);
  children.push(child);
  backendChildren.set(node.name, child);
  child.once('exit', (code, signal) => {
    backendLog.end();
    if (backendChildren.get(node.name) === child)
      backendChildren.delete(node.name);
    if (!stopping && !controlledBackendStops.has(child)) {
      console.error(`[lab] ${domain} backend exited (${signal ?? code})`);
      stop(1);
    }
  });
  return child;
}

async function restartBackendNode(node, domain) {
  const allowed = new Set([node.domain, node.transitionDomain]);
  if (!allowed.has(domain)) throw new Error(`unsupported lab domain ${domain}`);
  await stopBackendChild(backendChildren.get(node.name));
  startBackendNode(node, domain);
  await waitForUrl(
    `http://127.0.0.1:${node.backendPort}/api/v1/client/compat`,
    shutdown.signal,
  );
  console.log(`[lab] ${node.name} restarted as ${domain}`);
}

async function processControlRequests() {
  const controlDir = process.env.FED_LAB_CONTROL_DIR;
  if (!controlDir || controlBusy || stopping) return;
  controlBusy = true;
  try {
    const requestDir = join(controlDir, 'requests');
    const filenames = (await readdir(requestDir))
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const filename of filenames) {
      const requestPath = join(requestDir, filename);
      const claimedPath = `${requestPath}.processing`;
      try {
        await rename(requestPath, claimedPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      let response;
      try {
        const request = JSON.parse(await readFile(claimedPath, 'utf8'));
        const node = nodes.find(({ name }) => name === request.nodeName);
        if (!node)
          throw new Error(`unknown federation lab node ${request.nodeName}`);
        await restartBackendNode(node, request.domain);
        response = { ok: true, nodeName: node.name, domain: request.domain };
      } catch (error) {
        response = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      await writeFile(
        join(controlDir, 'responses', filename),
        `${JSON.stringify(response)}\n`,
        { mode: 0o600 },
      );
    }
  } finally {
    controlBusy = false;
  }
}

function spawnLoggedChild(name, command, args, options = {}) {
  mkdirSync(hmrLogDir, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(hmrLogDir, `${name}.log`), {
    flags: 'a',
    mode: 0o600,
  });
  const child = spawnChild(command, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SOMS_HMR_STATUS_DIR: hmrStatusDir,
      SOMS_HMR_SESSION_ID: hmrSessionId,
    },
    ...options,
  });
  child.stdout.pipe(process.stdout);
  child.stdout.pipe(log);
  child.stderr.pipe(process.stderr);
  child.stderr.pipe(log);
  child.once('exit', () => log.end());
  return child;
}

try {
  if (runBackend) {
    mkdirSync(runtimeDir, { recursive: true });
    for (const node of nodes) {
      if (stopping) break;
      await prepareDatabase(node.database);
      await run(
        process.execPath,
        [join(root, 'dist', 'scripts', 'migrate-db.js'), 'migrate'],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl(node.database) },
        },
      );
      prepareLabConfig(labDir, node.name);
      const nodeDir = join(runtimeDir, node.name);
      mkdirSync(join(nodeDir, 'data'), { recursive: true });
      // Backends run from the repository root and receive their mutable
      // directory through SOMS_DATA_DIR. Earlier runs created per-node symlinks
      // into the repository root instead; those encoded an environment-specific
      // mount path (container vs host) and broke startup after switching, so
      // retire any that are still around.
      for (const name of ['package.json', 'config']) {
        const legacy = join(nodeDir, name);
        try {
          if (lstatSync(legacy).isSymbolicLink()) unlinkSync(legacy);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  if (runFrontend && devServer && !stopping) {
    mkdirSync(hmrStatusDir, { recursive: true, mode: 0o700 });
    // Port preflight already established this process as the new lab owner. Retire any stale marker.
    writeHmrSession(hmrStatusDir, hmrSessionId, process.pid, true);
    hmrRecoveryTimer = setInterval(() => {
      try {
        restoreHmrSessionMarker();
      } catch (error) {
        console.error('[lab] HMR session marker recovery failed', error);
      }
    }, 2_000);
    hmrRecoveryTimer.unref();
    spawnLoggedChild('web', process.execPath, [
      join(root, 'scripts', 'hmr-observer.mjs'),
      'web',
      hmrStatusDir,
      '--',
      'npm',
      'run',
      'start',
      '--prefix',
      'web',
      '--',
      '--host',
      '0.0.0.0',
      '--port',
      String(webDevPort),
    ]);
    spawnLoggedChild('admin', 'npm', ['run', 'dev', '--prefix', 'admin-web']);
  }

  if (runBackend && !stopping) {
    for (const node of nodes) {
      if (stopping) break;
      startBackendNode(node);
    }
    const ready = await waitForServices(
      [
        {
          name: 'be',
          check: (signal) =>
            Promise.all(
              nodes.map((node) =>
                waitForUrl(
                  `http://127.0.0.1:${node.backendPort}/api/v1/client/compat`,
                  signal,
                ),
              ),
            ),
        },
      ],
      shutdown.signal,
    );
    if (ready) {
      if (process.env.FED_LAB_CONTROL_DIR) {
        controlTimer = setInterval(() => {
          void processControlRequests().catch((error) => {
            console.error('[lab] control request failed', error);
            stop(1);
          });
        }, 100);
      }
      console.log('\nThree-node federation backends are ready:');
      for (const node of nodes) {
        console.log(
          `  ${node.domain.padEnd(14)} http://127.0.0.1:${node.backendPort}`,
        );
      }
    }
  }

  if (runFrontend && !stopping) {
    const ready = devServer
      ? await waitForServices(
          [
            {
              name: 'admin',
              check: (signal) =>
                waitForUrl(
                  `http://127.0.0.1:${adminDevPort}/admin/`,
                  signal,
                  300_000,
                ),
            },
            {
              name: 'be',
              check: (signal) =>
                Promise.all(
                  nodes.map((node) =>
                    waitForUrl(
                      `http://127.0.0.1:${node.backendPort}/api/v1/client/compat`,
                      signal,
                    ),
                  ),
                ),
            },
            {
              name: 'web',
              check: (signal) =>
                waitForUrl(`http://127.0.0.1:${webDevPort}/`, signal, 300_000),
            },
          ],
          shutdown.signal,
        )
      : true;
    if (ready) {
      const caddyArgs = [
        'run',
        '--config',
        join(labDir, devServer ? 'Caddyfile.hmr' : 'Caddyfile.built'),
        '--adapter',
        'caddyfile',
      ];
      if (devServer) spawnLoggedChild('caddy', 'caddy', caddyArgs);
      else spawnChild('caddy', caddyArgs);
      console.log(
        `\nFederation frontend is ready (${devServer ? 'shared dev servers with HMR' : 'built assets'}):`,
      );
      for (const node of nodes) {
        console.log(
          `  ${node.domain.padEnd(14)} http://localhost:${node.edgePort}  admin: /admin/`,
        );
      }
      console.log(
        'Use three separate browser profiles. Press Ctrl+C to stop.\n',
      );
    }
  }
} catch (error) {
  // An interrupt mid-boot surfaces as a killed migrate child or an aborted
  // database connection; that is the shutdown path, not a lab failure. The
  // interrupt handler already set the exit code.
  if (!(stopping && interrupted)) throw error;
}

await finished;
