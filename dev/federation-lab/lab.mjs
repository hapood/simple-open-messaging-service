import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { prepareLabConfig } from './local-config.mjs';
import { ensureLabDatabase } from './database.mjs';
import { assertPortsFree } from './ports.mjs';
import { stopLabChildren } from './shutdown.mjs';
import {
  federationLabDatabaseUrl,
  federationLabNodes,
  federationLabRoutes,
} from './topology.mjs';

const labDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(labDir, '..', '..');
const runtimeDir = join(labDir, 'runtime');
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

const baseDatabaseUrl = process.env.DATABASE_URL?.trim();
if (runBackend && !baseDatabaseUrl) {
  throw new Error('DATABASE_URL is required in the repository .env');
}

const nodes = federationLabNodes;

function databaseUrl(database) {
  return federationLabDatabaseUrl(baseDatabaseUrl, database);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
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

async function prepareDatabase(database) {
  const admin = new URL(baseDatabaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const created = await ensureLabDatabase(client, database);
    console.log(`[lab] ${created ? 'created' : 'reusing'} ${database}`);
  } finally {
    await client.end();
  }
}

async function waitForUrl(url, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastResult = `HTTP ${response.status}`;
    } catch (error) {
      lastResult = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `${url} was not ready within ${timeoutMs / 1000} seconds (${lastResult})`,
  );
}

async function waitForServices(services) {
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
          await check();
          statuses[name] = 'ready';
        } catch (error) {
          statuses[name] = 'failed';
          throw error;
        }
      }),
    );
  } catch (error) {
    report();
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

if (runBackend) {
  mkdirSync(runtimeDir, { recursive: true });
  for (const node of nodes) {
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
    for (const name of ['package.json', 'config', 'shell-bundle']) {
      const legacy = join(nodeDir, name);
      try {
        if (lstatSync(legacy).isSymbolicLink()) unlinkSync(legacy);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
}

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
    LOG_LEVEL: process.env.FED_LAB_LOG_LEVEL ?? 'warn',
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

const children = [];
let stopping = false;
let finish;
const finished = new Promise((resolvePromise) => {
  finish = resolvePromise;
});

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  console.log('[lab] stopping children gracefully (up to 60s)');
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

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

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

if (runFrontend && devServer) {
  spawnChild('npm', [
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
  spawnChild('npm', ['run', 'dev', '--prefix', 'admin-web']);
}

if (runBackend) {
  for (const node of nodes) {
    const peerRoutes = { ...routes };
    delete peerRoutes[node.domain];
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
        env: labEnvironment(node, peerRoutes),
        detached: true,
      },
    );
    // Mirror each backend's stdout to the terminal AND its per-node log.
    const backendLog = createWriteStream(
      join(runtimeDir, node.name, 'backend.log'),
      { flags: 'a' },
    );
    child.stdout.pipe(backendLog);
    child.stdout.pipe(process.stdout);
    children.push(child);
    child.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(
          `[lab] ${node.domain} backend exited (${signal ?? code})`,
        );
        stop(1);
      }
    });
  }
  await waitForServices([
    {
      name: 'be',
      check: () =>
        Promise.all(
          nodes.map((node) =>
            waitForUrl(`http://127.0.0.1:${node.backendPort}/api/v1/health`),
          ),
        ),
    },
  ]);
  console.log('\nThree-node federation backends are ready:');
  for (const node of nodes) {
    console.log(
      `  ${node.domain.padEnd(14)} http://127.0.0.1:${node.backendPort}`,
    );
  }
}

if (runFrontend) {
  if (devServer) {
    await waitForServices([
      {
        name: 'admin',
        check: () =>
          waitForUrl(`http://127.0.0.1:${adminDevPort}/admin/`, 300_000),
      },
      {
        name: 'be',
        check: () =>
          Promise.all(
            nodes.map((node) =>
              waitForUrl(`http://127.0.0.1:${node.backendPort}/api/v1/health`),
            ),
          ),
      },
      {
        name: 'web',
        check: () => waitForUrl(`http://127.0.0.1:${webDevPort}/`, 300_000),
      },
    ]);
  }
  spawnChild('caddy', [
    'run',
    '--config',
    join(labDir, devServer ? 'Caddyfile.hmr' : 'Caddyfile.built'),
    '--adapter',
    'caddyfile',
  ]);
  console.log(
    `\nFederation frontend is ready (${devServer ? 'shared dev servers with HMR' : 'built assets'}):`,
  );
  for (const node of nodes) {
    console.log(
      `  ${node.domain.padEnd(14)} http://localhost:${node.edgePort}  admin: /admin/`,
    );
  }
  console.log('Use three separate browser profiles. Press Ctrl+C to stop.\n');
} else {
  console.log('Press Ctrl+C to stop.\n');
}

await finished;
