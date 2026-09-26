#!/usr/bin/env node
/**
 * Exercise the running lab's real /events handler directly and through Caddy.
 * Uses an isolated account session and prints only connection counts/timings.
 * No password, one-time code, session token, or response body is logged.
 *
 * SOMS_SSE_PROBE_ACCOUNT=<existing test account> node scripts/probe-sse-disconnect.mjs
 * Optional: SOMS_SSE_PROBE_NODE=alpha (default),
 *           SOMS_ADMIN_PASSWORD_FILE=/path/to/private/password (default /dev/shm/soms-admin-pw)
 */
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import { LabAdminActor } from '../dev/federation-lab/p2p/api-actors.mjs';
import { federationLabNode } from '../dev/federation-lab/topology.mjs';

const account = process.env.SOMS_SSE_PROBE_ACCOUNT;
if (!account || !/^[a-zA-Z0-9_-]{3,31}$/.test(account)) {
  console.error(
    'Set SOMS_SSE_PROBE_ACCOUNT to an existing isolated test account.',
  );
  process.exit(2);
}

const node = federationLabNode(process.env.SOMS_SSE_PROBE_NODE ?? 'alpha');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let token;

async function connections(admin, userId) {
  const snapshot = await admin.post('/admin/connections');
  return (
    snapshot.clients.find((client) => client.userId === userId)?.connections ??
    0
  );
}

async function waitForConnections(admin, userId, expected) {
  const started = Date.now();
  let observed;
  while (Date.now() - started < 8000) {
    observed = await connections(admin, userId);
    if (observed === expected) return Date.now() - started;
    await delay(150);
  }
  throw new Error(
    `SSE count did not reach ${expected}; last observed ${observed}`,
  );
}

function openStream(origin) {
  return new Promise((resolve, reject) => {
    const request = get(`${origin}/api/v1/events`, {
      headers: { Authorization: `Bearer ${token}` },
      agent: false,
    });
    request.on('error', reject);
    request.setTimeout(8000, () =>
      request.destroy(new Error('SSE response timeout')),
    );
    request.on('response', (response) => {
      if (
        response.statusCode !== 200 ||
        !response.headers['content-type']?.startsWith('text/event-stream')
      ) {
        response.destroy();
        reject(
          new Error(`Unexpected SSE response status ${response.statusCode}`),
        );
        return;
      }
      response.on('error', () => {});
      response.resume();
      resolve({ request, response });
    });
  });
}

async function run() {
  const admin = await LabAdminActor.login({
    node,
    password: (
      await readFile(
        process.env.SOMS_ADMIN_PASSWORD_FILE ?? '/dev/shm/soms-admin-pw',
        'utf8',
      )
    ).trim(),
  });
  const users = await admin.post('/admin/users', { search: account, take: 3 });
  const userId = users.list.find((user) => user.account === account)?.id;
  if (!Number.isInteger(userId)) throw new Error('Test account not found');
  const baseline = await connections(admin, userId);
  const issued = await admin.post(
    `/admin/users/${userId}/issue-login-code`,
    {},
  );
  const login = await fetch(`${node.backendBaseUrl}/api/v1/auth/otp/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account,
      code: issued.code,
      client: 'app',
      device: 'sse-disconnect-probe',
    }),
  });
  const result = await login.json();
  if (!login.ok || result.code !== 0 || !result.data?.session_token) {
    throw new Error('Test session login failed');
  }
  token = result.data.session_token;
  console.log(`baseline=${baseline}`);

  for (const [label, origin] of [
    ['direct', node.backendBaseUrl],
    ['caddy', node.browserBaseUrl],
  ]) {
    const { request, response } = await openStream(origin);
    try {
      const connectedMs = await waitForConnections(admin, userId, baseline + 1);
      // Destroy the downstream socket without calling response.end().
      response.destroy();
      request.destroy();
      const removedMs = await waitForConnections(admin, userId, baseline);
      console.log(
        `${label}: connected=${connectedMs}ms removed=${removedMs}ms PASS`,
      );
    } finally {
      response.destroy();
      request.destroy();
    }
  }
}

try {
  await run();
} catch {
  // Suppress network/HTTP error details: they may contain request headers or codes.
  console.error(
    'SSE disconnect probe failed; credentials and response bodies suppressed.',
  );
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      await fetch(`${node.backendBaseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
    } catch {
      console.error(
        'Probe session logout failed; check the test account session list.',
      );
      process.exitCode = 1;
    }
  }
}
