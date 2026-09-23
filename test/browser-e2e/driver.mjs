// Persistent browser driver for manual-style E2E runs.
// Each user/admin gets a persistent Chromium context (userDataDir on disk),
// so sessions and client IndexedDB survive driver restarts.
// Protocol: JSON lines on stdin; results as JSON lines on stdout.
//   {"id":1,"action":"adminLogin","node":"alpha"}
//   {"id":2,"action":"issueOtp","node":"alpha","account":"alice"}
//   {"id":3,"action":"userLogin","user":"alice","node":"alpha","account":"alice"}
//   {"id":4,"action":"eval","user":"alice","script":"/abs/step.mjs"}
//   {"id":5,"action":"shot","user":"alice","name":"after-send"}
//   {"id":6,"action":"errors","user":"alice"}
//   {"id":7,"action":"resetUser","user":"alice"}   // wipe profile (fresh identity)
//   {"id":8,"action":"close"}
// Secrets (admin password, OTPs) are read from .env / kept in memory only.
import { chromium, expect } from '@playwright/test';
import { readFileSync, rmSync, existsSync, mkdirSync, readdirSync, readlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';

const NODES = {
  alpha: {
    edge: 'http://localhost:3101/',
    admin: 'http://localhost:3101/admin/',
  },
  bravo: {
    edge: 'http://localhost:3102/',
    admin: 'http://localhost:3102/admin/',
  },
  charlie: {
    edge: 'http://localhost:3103/',
    admin: 'http://localhost:3103/admin/',
  },
};
const SHOTS = process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
const PROFILES = process.env.BROWSER_PROFILE_DIR || `${SHOTS}/profiles`;
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
  (existsSync('.env') ? readFileSync('.env', 'utf8') : '')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
// Temporary lab credential override lives in tmpfs (memory-backed), never in the repo.
let tmpPw = '';
try {
  tmpPw = readFileSync('/dev/shm/soms-admin-pw', 'utf8').trim();
} catch {}
const ADMIN_PASSWORD =
  process.env.BROWSER_ADMIN_PASSWORD || tmpPw || env.ADMIN_BOOTSTRAP_PASSWORD;
function requireAdminPassword() {
  if (!ADMIN_PASSWORD)
    throw new Error(
      'Set BROWSER_ADMIN_PASSWORD or provide /dev/shm/soms-admin-pw',
    );
  return ADMIN_PASSWORD;
}

const contexts = new Map(); // name -> { context, page, consoleErrors[], pageErrors[] }

function profileOwner(name) {
  const lock = `${PROFILES}/${name}/SingletonLock`;
  if (!existsSync(`${PROFILES}/${name}`)) return null;
  let target;
  try {
    target = readlinkSync(lock);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { state: 'unknown', reason: 'Cannot inspect Chrome profile lock' };
  }
  const match = /-(\d+)$/.exec(target);
  if (!match) return { state: 'unknown', reason: 'Chrome profile lock has no recognizable PID' };
  const pid = Number(match[1]);
  try {
    process.kill(pid, 0);
    return { state: 'occupied', pid };
  } catch (error) {
    // EPERM still means a live owner. A stale lock must not be removed by
    // this diagnostic; Chromium owns its own profile locking lifecycle.
    if (error?.code === 'EPERM') return { state: 'occupied', pid };
    if (error?.code === 'ESRCH') return { state: 'stale', pid };
    return { state: 'unknown', reason: 'Could not verify Chrome profile owner' };
  }
}

function externalProfiles() {
  return readdirSync(PROFILES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !contexts.has(entry.name))
    .flatMap((entry) => {
      const owner = profileOwner(entry.name);
      return owner ? [{ name: entry.name, ...owner }] : [];
    });
}
const otps = new Map(); // account -> code (memory only, never printed)

function out(id, ok, data) {
  process.stdout.write(JSON.stringify({ id, ok, data }) + '\n');
}
function fail(id, err) {
  process.stdout.write(
    JSON.stringify({
      id,
      ok: false,
      error: String((err && err.stack) || err).slice(0, 3000),
    }) + '\n',
  );
}

async function newSession(name, viewport) {
  validName(name);
  if (contexts.has(name)) return contexts.get(name);
  const owner = profileOwner(name);
  if (owner?.state === 'occupied') {
    throw new Error(
      `Profile ${name} is held by Chrome PID ${owner.pid} outside this driver. Close its owning driver/context cleanly, then retry; do not delete SingletonLock or reset the profile.`,
    );
  }
  const context = await chromium.launchPersistentContext(
    `${PROFILES}/${name}`,
    {
      headless: process.env.BROWSER_HEADFUL !== '1',
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      ignoreHTTPSErrors: true,
      viewport: viewport || { width: 1440, height: 1000 },
      args: [
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  );
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  const rec = {
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

async function adminLogin(node) {
  const name = `admin-${node}`;
  const { page } = await newSession(name);
  const base = NODES[node].admin;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  if (page.url().includes('/login')) {
    await page.locator('#account').fill('admin');
    await page.locator('#password').fill(requireAdminPassword());
    await page.locator('form button[type="submit"]').click();
    // Users page renders a search input; this is the reliable logged-in signal.
    await page.getByRole('searchbox').waitFor({
      state: 'visible',
      timeout: 20000,
    });
  }
  if (page.url().includes('/login')) throw new Error('admin login failed');
  return { node, url: page.url() };
}

async function issueOtp(node, account) {
  const name = `admin-${node}`;
  if (!contexts.has(name)) await adminLogin(node);
  const { page } = contexts.get(name);
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
      ...users.data.list.filter(
        (user) => user.account === account && user.domain === 'local',
      ),
    );
    skip += take;
  }
  if (matches.length !== 1) {
    throw new Error(`expected one exact local account for ${account}`);
  }
  const targetId = matches[0].id;
  await page.goto(
    base.replace(/\/$/, '') + `/users/${targetId}`,
    { waitUntil: 'domcontentloaded' },
  );
  const openIssue = page.locator(
    'button[aria-controls="issue-login-code-dialog"]',
  );
  await openIssue.waitFor({ state: 'visible', timeout: 10000 });
  await openIssue.click();
  await page.waitForTimeout(600);
  const dialog = page.locator('#issue-login-code-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  const confirm = dialog.locator('button[type="submit"]');
  await confirm.waitFor({ state: 'visible', timeout: 10000 });
  await confirm.click();
  const codeInput = dialog.locator('#ilc-code');
  await codeInput.waitFor({ state: 'visible', timeout: 15000 });
  const code = await codeInput.inputValue();
  otps.set(account, code);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  return { account, codeLength: code.length };
}

async function userLogin(user, node, account) {
  const { page } = await newSession(user);
  await page.goto(NODES[node].edge, { waitUntil: 'domcontentloaded' });
  // Wait for either the authenticated shell or the login entry.
  const hint = page.locator('app-icon-rail .icon-rail');
  const other = page.locator('app-auth-method-menu > button');
  await expect(hint.or(other)).toBeVisible({ timeout: 30000 });
  if (await hint.isVisible())
    return { user, node, url: page.url(), resumed: true };
  const code = otps.get(account);
  if (!code) throw new Error(`no OTP in memory for ${account}; issue first`);
  if (await other.isVisible().catch(() => false)) {
    await other.click();
    // Password sign-in does not offer a password menu item, so OTP is first.
    await page.getByRole('menu').getByRole('menuitem').first().click();
  }
  await page.locator('input[name="account"]').fill(account);
  await page.locator('input[name="code"]').fill(code);
  await page.locator('form button[type="submit"]').click();
  // Wait for the authenticated shell, including when a thread is selected.
  await hint.waitFor({ state: 'visible', timeout: 30000 });
  otps.delete(account);
  return { user, node, url: page.url() };
}

async function shot(user, name) {
  validName(name);
  const rec = contexts.get(user);
  if (!rec) throw new Error(`no session ${user}`);
  // Background headless pages produce stale/blank frames; activate first.
  await rec.page.bringToFront();
  await rec.page.waitForTimeout(350);
  const path = `${SHOTS}/${name}.png`;
  await rec.page.screenshot({ path, fullPage: false });
  return { path };
}

const actions = {
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
    await rec.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    return { started: c.user };
  },
  async traceStop(c) {
    const rec = contexts.get(c.user);
    if (!rec) throw new Error(`no session ${c.user}`);
    const path = `${SHOTS}/${validName(c.name)}.zip`;
    await rec.context.tracing.stop({ path });
    return { path };
  },
  status: () => ({
    profiles: [...contexts].map(([name, rec]) => ({
      name,
      url: rec.page.url(),
    })),
    externalProfiles: externalProfiles(),
    nodes: NODES,
    artifacts: SHOTS,
  }),
  async open(c) {
    const { page } = await newSession(c.user, c.viewport);
    await page.goto(c.url || NODES[c.node || 'alpha'].edge, {
      waitUntil: 'domcontentloaded',
    });
    return { user: c.user, url: page.url() };
  },
  async inspect(c) {
    const { page } = await newSession(c.user);
    return {
      url: page.url(),
      snapshot: await page.locator('body').ariaSnapshot(),
    };
  },
  adminLogin: (c) => adminLogin(c.node),
  issueOtp: (c) => issueOtp(c.node, c.account),
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
      // In-memory only; steps must not return or persist this value.
      adminPassword: ADMIN_PASSWORD,
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
    const dir = `${PROFILES}/${c.user}`;
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
      if (!actions[action]) throw new Error(`unknown action ${action}`);
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
