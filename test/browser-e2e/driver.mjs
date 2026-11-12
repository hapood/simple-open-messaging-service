// Persistent browser driver for manual-style E2E runs.
// Each user/admin gets a persistent Chromium context (userDataDir on disk),
// so sessions and client IndexedDB survive driver restarts.
// Protocol: JSON lines on stdin; results as JSON lines on stdout.
//   {"id":1,"action":"adminLogin","node":"alpha"}
//   {"id":2,"action":"issueOtp","node":"alpha","account":"alice"}
// Both accept an optional "user" field naming the admin profile to use, so
// parallel sessions can hold their own admin console instead of contending
// for the shared "admin-<node>" profile (e.g. "user":"admin-parallel-1").
//   {"id":3,"action":"userLogin","user":"alice","node":"alpha","account":"alice"}
//   {"id":4,"action":"eval","user":"alice","script":"/abs/step.mjs"}
//   {"id":5,"action":"shot","user":"alice","name":"after-send"}
//   {"id":6,"action":"errors","user":"alice"}
//   {"id":7,"action":"resetUser","user":"alice"}   // wipe profile (fresh identity)
//   {"id":8,"action":"close"}
// Configured credentials arrive on a private pipe; OTPs stay in memory.
// Direct local-lab mode retains explicit environment/tmpfs credential overrides.
import { chromium, expect, request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { Socket } from 'node:net';

import { browserLaunchOptions } from './infrastructure/browser-runtime.mjs';
import {
  federationNodes,
  navigationUrl as targetNavigationUrl,
  assertProfileTarget,
} from './infrastructure/targets.mjs';
import {
  profileTarget,
  profileDirectory,
} from './infrastructure/profile-targets.mjs';
import {
  resolveDeploymentIdentity,
  validateDeployment,
} from './infrastructure/acceptance-run.mjs';
import { otpKey, redactSecrets } from './infrastructure/driver-secrets.mjs';
const deployment = process.env.BROWSER_DEPLOYMENT_FILE
  ? JSON.parse(readFileSync(process.env.BROWSER_DEPLOYMENT_FILE, 'utf8'))
  : undefined;
const NODES = deployment
  ? validateDeployment(deployment.mode, deployment.nodes)
  : federationNodes;
const navigationUrl = (target, node, url) =>
  targetNavigationUrl(target, node, url, NODES);
// The private pipe is not a command argument, environment secret, or model tool parameter.
const credentials = deployment
  ? await new Promise((resolve, reject) => {
      const pipe = new Socket({ fd: 3, readable: true, writable: false });
      let text = '';
      pipe.setEncoding('utf8');
      pipe.on('data', (chunk) => {
        text += chunk;
      });
      pipe.on('error', reject);
      pipe.on('end', () => {
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('Invalid private credential transport.'));
        }
      });
    })
  : {};
const knownSecrets = new Set(Object.values(credentials));
const safe = (value) => redactSecrets(value, knownSecrets);
const ARTIFACT_ROOT =
  process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
const SHOTS = `${ARTIFACT_ROOT}/runs/${Date.now()}-${randomUUID()}`;
const PROFILES = process.env.BROWSER_PROFILE_DIR || `${ARTIFACT_ROOT}/profiles`;
mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
mkdirSync(PROFILES, { recursive: true, mode: 0o700 });
function validName(name) {
  if (
    typeof name !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)
  )
    throw new Error(
      'Use a profile/artifact name containing letters, digits, underscores or hyphens',
    );
  return name;
}
const env = Object.fromEntries(
  (!deployment && existsSync('.env') ? readFileSync('.env', 'utf8') : '')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      // Dotenv-compatible values: strip one pair of matching surrounding quotes.
      let value = l.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return [l.slice(0, i).trim(), value];
    }),
);
// Temporary lab credential override lives in tmpfs (memory-backed), never in the repo.
let tmpPw = '';
try {
  if (!deployment)
    tmpPw = readFileSync('/dev/shm/soms-admin-pw', 'utf8').trim();
} catch {}
const ADMIN_PASSWORD =
  process.env.BROWSER_ADMIN_PASSWORD || tmpPw || env.ADMIN_BOOTSTRAP_PASSWORD;
if (!deployment && ADMIN_PASSWORD) knownSecrets.add(ADMIN_PASSWORD);
function requireAdminPassword(node) {
  const password = deployment ? credentials[node] : ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      'Set BROWSER_ADMIN_PASSWORD or provide /dev/shm/soms-admin-pw',
    );
  return password;
}

const contexts = new Map(); // name -> { context, page, consoleErrors[], pageErrors[] }

function profileOwner(name, target = 'federation') {
  const directory = profileDirectory(PROFILES, name, target);
  const lock = `${directory}/SingletonLock`;
  if (!existsSync(directory)) return null;
  let lockTarget;
  try {
    lockTarget = readlinkSync(lock);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { state: 'unknown', reason: 'Cannot inspect Chrome profile lock' };
  }
  const match = /-(\d+)$/.exec(lockTarget);
  if (!match)
    return {
      state: 'unknown',
      reason: 'Chrome profile lock has no recognizable PID',
    };
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return { state: 'occupied', pid };
  } catch (error) {
    // EPERM still means a live owner. A stale lock must not be removed by
    // this diagnostic; Chromium owns its own profile locking lifecycle.
    if (error?.code === 'EPERM') return { state: 'occupied', pid };
    if (error?.code === 'ESRCH') return { state: 'stale', pid };
    return {
      state: 'unknown',
      reason: 'Could not verify Chrome profile owner',
    };
  }
}

function externalProfiles() {
  return ['federation', 'playground'].flatMap((target) => {
    const directory =
      target === 'playground' ? `${PROFILES}/.playground` : PROFILES;
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          !contexts.has(entry.name),
      )
      .flatMap((entry) => {
        const owner = profileOwner(entry.name, target);
        return owner ? [{ name: entry.name, target, ...owner }] : [];
      });
  });
}
const otps = new Map(); // account -> code (memory only, never printed)

function out(id, ok, data) {
  process.stdout.write(
    JSON.stringify({ id, ok, data }, (_key, value) =>
      typeof value === 'string' ? safe(value) : value,
    ) + '\n',
  );
}
function fail(id, err) {
  process.stdout.write(
    JSON.stringify({
      id,
      ok: false,
      error: safe(String((err && err.stack) || err)).slice(0, 3000),
    }) + '\n',
  );
}

async function newSession(name, viewport, requestedTarget) {
  validName(name);
  if (contexts.has(name)) {
    const rec = contexts.get(name);
    if (requestedTarget) assertProfileTarget(rec.target, requestedTarget);
    return rec;
  }
  const target = profileTarget(PROFILES, name, requestedTarget);
  const owner = profileOwner(name, target);
  if (owner?.state === 'occupied') {
    throw new Error(
      `Profile ${name} is held by Chrome PID ${owner.pid} outside this driver. Close its owning driver/context cleanly, then retry; do not delete SingletonLock or reset the profile.`,
    );
  }
  const context = await chromium.launchPersistentContext(
    profileDirectory(PROFILES, name, target),
    {
      ...browserLaunchOptions(),
      ignoreHTTPSErrors: !deployment,
      viewport: viewport || { width: 1440, height: 1000 },
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        // Auto-grant media prompts with fake devices so call flows are
        // deterministic in headless profiles (localhost is already secure).
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  );
  // Validate document navigations, including redirects/popups and trusted step page.goto calls.
  // This is a navigation guard, not a sandbox for trusted Node step modules or app subresources.
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest()) {
      try {
        navigationUrl(target, undefined, request.url());
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
    }
    await route.continue();
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  // Stored profile content settings may carry a persisted media-permission
  // block from an earlier auto-dismissed prompt; re-grant for every lab origin.
  for (const node of target === 'federation' ? Object.values(NODES) : []) {
    await context
      .grantPermissions(['microphone', 'camera'], { origin: node.edge })
      .catch(() => {});
  }
  const rec = {
    target,
    context,
    page,
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };
  const record = (list, value) => {
    list.push(value);
    if (list.length > 100) list.shift();
  };
  page.on('requestfailed', (request) =>
    record(rec.requestFailures, {
      url: new URL(request.url()).origin + new URL(request.url()).pathname,
      error: request.failure()?.errorText,
    }),
  );
  page.on('console', (m) => {
    if (m.type() === 'error') record(rec.consoleErrors, m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => record(rec.pageErrors, String(e).slice(0, 500)));
  contexts.set(name, rec);
  return rec;
}

function bindLoginProfile(name, role, node, account) {
  const file = `${profileDirectory(PROFILES, name, 'federation')}/.soms-test-identity.json`;
  const identity = { role, node, account };
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(identity))
      throw new Error(
        'Profile belongs to another node/account/role; use a separate profile.',
      );
  } else
    writeFileSync(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
}

async function adminLogin(node, profile) {
  const name = validName(profile || `admin-${node}`);
  navigationUrl('federation', node);
  const rec = await newSession(name, undefined, 'federation');
  if (rec.adminNode && rec.adminNode !== node)
    throw new Error('Admin profile belongs to another node.');
  if (rec.tracing) throw new Error('Stop tracing before authentication.');
  bindLoginProfile(name, 'admin', node, NODES[node].account || 'admin');
  rec.adminNode = node;
  const { page } = rec;
  const base = NODES[node].admin;
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    // The SPA may still be redirecting to /login; settle before checking.
    await page.waitForURL(/\/admin\/login/, { timeout: 5000 }).catch(() => {});
    if (page.url().includes('/login')) {
      await page.locator('#account').fill(NODES[node].account || 'admin');
      await page.locator('#password').fill(requireAdminPassword(node));
      await page.locator('form button[type="submit"]').click();
    }
    // Users page renders a search input; this is the reliable logged-in signal.
    await page.getByRole('searchbox').waitFor({
      state: 'visible',
      timeout: 20000,
    });
    // The login page can also expose a searchbox, so confirm the URL.
    if (page.url().includes('/login')) throw new Error('admin login failed');
    const identityResponse = await page.request.post(
      new URL('/api/v1/admin/me', base).href,
      { maxRedirects: 0 },
    );
    const identity = await identityResponse.json();
    if (!identityResponse.ok() || identity.code !== 0)
      throw new Error('Cannot read authenticated Admin identity.');
    resolveDeploymentIdentity(NODES, node, identity.data?.somsDomain);
  } catch (error) {
    // Drop the half-open session so the next attempt retries login instead of
    // silently reusing a logged-out page.
    const rec = contexts.get(name);
    if (rec) {
      await rec.context.close().catch(() => {});
      contexts.delete(name);
    }
    throw error;
  }
  return { node, url: page.url(), domain: NODES[node].domain };
}

async function issueOtp(node, account, profile) {
  const name = validName(profile || `admin-${node}`);
  const existing = contexts.get(name);
  // Retry login when a cached session sits on the login page (e.g. after a
  // password rotation) instead of issuing an unauthenticated lookup.
  if (existing && existing.page.url().includes('/login')) {
    await existing.context.close().catch(() => {});
    contexts.delete(name);
  }
  if (!contexts.has(name)) await adminLogin(node, profile);
  const rec = contexts.get(name);
  if (rec.adminNode !== node)
    throw new Error('Admin profile belongs to another node.');
  if (rec.tracing) throw new Error('Stop tracing before issuing an OTP.');
  const { page } = rec;
  const base = NODES[node].admin;
  const matches = [];
  const take = 20;
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const result = await page.request.post(
      new URL('/api/v1/admin/users', base).href,
      { data: { search: account, skip, take } },
    );
    const users = await result.json();
    if (
      !result.ok() ||
      users.code !== 0 ||
      !Array.isArray(users.data?.list) ||
      !Number.isInteger(users.data?.total)
    ) {
      throw new Error(`admin user lookup failed for ${account}`);
    }
    total = users.data.total;
    matches.push(
      // Current Admin user lists contain local accounts only. Older responses may
      // include domain labels; never accept a peer-labelled entry from those versions.
      ...users.data.list.filter(
        (user) =>
          user.account === account &&
          (user.domain === undefined || user.domain === NODES[node].domain),
      ),
    );
    skip += take;
  }
  if (matches.length !== 1) {
    throw new Error(`expected one exact local account for ${account}`);
  }
  const targetId = matches[0].id;
  await page.goto(base.replace(/\/$/, '') + `/users/${targetId}`, {
    waitUntil: 'domcontentloaded',
  });
  const openIssue = page.locator(
    'button[aria-controls="issue-login-code-dialog"]',
  );
  await openIssue.waitFor({ state: 'visible', timeout: 10000 });
  await openIssue.click();
  const dialog = page.locator('#issue-login-code-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const confirm = dialog.locator('button[type="submit"]');
  await confirm.waitFor({ state: 'visible', timeout: 10000 });
  await confirm.click();
  const codeInput = dialog.locator('#ilc-code');
  await codeInput.waitFor({ state: 'visible', timeout: 15000 });
  const code = await codeInput.inputValue();
  otps.set(otpKey(node, account), code);
  knownSecrets.add(code);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  return { account, codeLength: code.length };
}

async function userLogin(user, node, account) {
  const rec = await newSession(user, undefined, 'federation');
  bindLoginProfile(user, 'user', node, account);
  if (rec.tracing) throw new Error('Stop tracing before authentication.');
  const { page } = rec;
  await page.goto(NODES[node].edge, { waitUntil: 'domcontentloaded' });
  // Wait for either the authenticated shell or the login entry.
  const hint = page.locator('app-icon-rail .icon-rail');
  const otpTab = page.getByRole('tab', { name: /OTP/i });
  await expect(hint.or(otpTab)).toBeVisible({ timeout: 30000 });
  if (await hint.isVisible())
    return { user, node, url: page.url(), resumed: true };
  const code = otps.get(otpKey(node, account));
  if (!code) throw new Error(`no OTP in memory for ${account}; issue first`);
  await otpTab.click();
  const panel = page.locator('.mat-mdc-tab-body-active');
  await panel.locator('input[name="otpAccount"]').fill(account);
  await panel.locator('input[name="code"]').fill(code);
  await panel.locator('button[type="submit"]').click();
  // Wait for the authenticated shell, including when a thread is selected.
  await hint.waitFor({ state: 'visible', timeout: 30000 });
  otps.delete(otpKey(node, account));
  return { user, node, url: page.url() };
}

async function shot(user, name) {
  validName(name);
  const rec = contexts.get(user);
  if (!rec) throw new Error(`no session ${user}`);
  await assertEvidenceSafe(rec);
  // Background headless pages produce stale/blank frames; activate first.
  await rec.page.bringToFront();
  await rec.page.waitForTimeout(350);
  const path = `${SHOTS}/${name}.png`;
  await rec.page.screenshot({ path, fullPage: false });
  return { path };
}

async function assertEvidenceSafe(rec) {
  if (
    /\/(login|auth)(\/|$)/.test(new URL(rec.page.url()).pathname) ||
    (await rec.page
      .locator('input[type="password"]:visible, #ilc-code:visible')
      .count())
  )
    throw new Error('Authentication surfaces must not be captured.');
}

const actions = {
  async preflight() {
    const client = await request.newContext({
      ignoreHTTPSErrors: !deployment,
      timeout: 15_000,
    });
    try {
      const result = {};
      for (const [key, node] of Object.entries(NODES)) {
        const health = {};
        for (const [label, url] of [
          ['web', node.edge],
          ['admin', node.admin],
          ['edgeCompat', new URL('/api/v1/client/compat', node.edge).href],
          [
            'serviceCompat',
            new URL('/api/v1/client/compat', node.service || node.edge).href,
          ],
        ]) {
          const approved = label.endsWith('Compat')
            ? [new URL(url).origin]
            : [new URL(node.edge).origin, new URL(node.admin).origin];
          let destination = url;
          let response;
          for (let hop = 0; hop < 5; hop++) {
            response = await client.get(destination, { maxRedirects: 0 });
            if (![301, 302, 303, 307, 308].includes(response.status())) break;
            const location = response.headers().location;
            if (!location)
              throw new Error(`${key} ${label}: redirect missing Location.`);
            const next = new URL(location, destination);
            if (
              next.username ||
              next.password ||
              !approved.includes(next.origin)
            )
              throw new Error(
                `${key} ${label}: redirect outside approved origins.`,
              );
            destination = next.href;
          }
          if (!response.ok())
            throw new Error(
              `${key} ${label}: HTTP ${response.status()}; verify the configured canonical URL.`,
            );
          if (label.endsWith('Compat')) {
            const body = await response.json();
            const data = body.data ?? body;
            if (
              typeof data.serverVersion !== 'string' ||
              data.apiVersion === undefined
            )
              throw new Error(
                `${key} ${label}: unexpected compatibility contract; classify environment versus driver mismatch.`,
              );
            health[label] = {
              serverVersion: data.serverVersion,
              apiVersion: data.apiVersion,
            };
          } else health[label] = { status: response.status() };
        }
        if (
          JSON.stringify(health.edgeCompat) !==
          JSON.stringify(health.serviceCompat)
        )
          throw new Error(
            `${key}: edge/backend compatibility identity differs; verify routing and deployed versions.`,
          );
        result[key] = health;
      }
      return result;
    } finally {
      await client.dispose();
    }
  },
  async closeUser(c) {
    const rec = contexts.get(c.user);
    if (rec) {
      await rec.context.close();
      contexts.delete(c.user);
    }
    return { closed: c.user, profileRetained: true };
  },
  async traceStart(c) {
    const rec = await newSession(c.user);
    await assertEvidenceSafe(rec);
    await rec.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    rec.tracing = true;
    return { started: c.user };
  },
  async traceStop(c) {
    const rec = contexts.get(c.user);
    if (!rec) throw new Error(`no session ${c.user}`);
    const path = `${SHOTS}/${validName(c.name)}.zip`;
    await rec.context.tracing.stop({ path });
    rec.tracing = false;
    return { path };
  },
  status: () => ({
    profiles: [...contexts].map(([name, rec]) => ({
      name,
      target: rec.target,
      url: rec.page.url(),
    })),
    externalProfiles: externalProfiles(),
    nodes: NODES,
    artifacts: SHOTS,
  }),
  async open(c) {
    const target = profileTarget(PROFILES, validName(c.user), c.target);
    const url = navigationUrl(target, c.node, c.url);
    const { page } = await newSession(c.user, c.viewport, target);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { user: c.user, target, url: page.url() };
  },
  async inspect(c) {
    const rec = await newSession(c.user);
    await assertEvidenceSafe(rec);
    const { page } = rec;
    return {
      url: page.url(),
      snapshot: await page.locator('body').ariaSnapshot(),
    };
  },
  adminLogin: (c) => adminLogin(c.node, c.user),
  issueOtp: (c) => issueOtp(c.node, c.account, c.user),
  userLogin: (c) => userLogin(c.user, c.node, c.account),
  shot: (c) => shot(c.user, c.name),
  errors: (c) => {
    const rec = contexts.get(c.user);
    if (!rec) throw new Error(`no session ${c.user}`);
    const result = {
      consoleErrors: [...rec.consoleErrors],
      pageErrors: [...rec.pageErrors],
      requestFailures: [...rec.requestFailures],
    };
    if (c.clear) {
      rec.consoleErrors.length = 0;
      rec.pageErrors.length = 0;
      rec.requestFailures.length = 0;
    }
    return result;
  },
  async eval(c) {
    const rec = await newSession(c.user);
    const mod = await import(pathToFileURL(c.script).href + `?t=${Date.now()}`);
    const pageOf = (n) => {
      const r = contexts.get(n);
      if (!r) throw new Error(`no session ${n}`);
      return r.page;
    };
    const helpers = {
      expect,
      page: rec.page,
      context: rec.context,
      pageOf,
      shot,
      nodes: NODES,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
    const data = await mod.default(helpers);
    return data === undefined ? { done: true } : data;
  },
  async resetUser(c) {
    validName(c.user);
    const rec = contexts.get(c.user);
    if (rec) {
      await rec.context.close().catch(() => {});
      contexts.delete(c.user);
    }
    const target = profileTarget(PROFILES, c.user, c.target);
    const owner = profileOwner(c.user, target);
    if (owner && owner.state !== 'stale')
      throw new Error('Cannot reset a profile owned by another process.');
    const dir = profileDirectory(PROFILES, c.user, target);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return { reset: c.user };
  },
  async close() {
    for (const { context } of contexts.values())
      await context.close().catch(() => {});
    contexts.clear();
    return { closed: true };
  },
};

const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const cmd = queue.shift();
    const { id, action } = cmd;
    try {
      if (!Object.hasOwn(actions, action))
        throw new Error(`unknown action ${action}`);
      if (cmd.target && cmd.user && !['open', 'resetUser'].includes(action))
        profileTarget(PROFILES, validName(cmd.user), cmd.target);
      if (['adminLogin', 'issueOtp', 'userLogin'].includes(action)) {
        if (!Object.hasOwn(NODES, cmd.node))
          throw new Error('Select a valid federation node.');
        if (cmd.target && cmd.target !== 'federation')
          throw new Error('Login helpers require federation.');
        profileTarget(
          PROFILES,
          validName(cmd.user || `admin-${cmd.node}`),
          'federation',
        );
      }
      const data = await actions[action](cmd);
      out(id, true, data);
    } catch (err) {
      fail(id, err);
    }
  }
  busy = false;
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    queue.push(JSON.parse(line));
  } catch {
    fail(null, new Error('Invalid JSON command'));
    return;
  }
  void pump();
});
process.stdout.write(
  JSON.stringify({ id: 0, ok: true, data: { ready: true } }) + '\n',
);

process.once('SIGINT', async () => {
  await actions.close();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await actions.close();
  process.exit(0);
});
