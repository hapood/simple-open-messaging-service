import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LabAdminActor } from './p2p/api-actors.mjs';
import { federationLabNode } from './topology.mjs';

/**
 * Group-join latency probe for the federation lab.
 *
 * Attaches to two already-running lab backends (default: alpha = applicant, bravo = group
 * owner), provisions one applicant and one owner through the real HTTP API, walks the full
 * "apply to join → owner allows join" flow, and measures — from the owner's
 * POST /group/join-request/accept call — when each node:
 *   1. returns the accept admission (durable task id),
 *   2. finishes the accept durable task,
 *   3. pushes the SSE hint (THREAD_FEED_UPDATED / STATE_FEED_UPDATED),
 *   4. serves the GROUP_JOINED system message (with the local thread id).
 *
 * Usage (repository root, with the lab backends running, e.g. `npm run dev:be`):
 *   node dev/federation-lab/group-join-latency.mjs [--prefix=join] [--applicant=alpha]
 *       [--owner=bravo] [--window-timeout-ms=30000] [--poll-interval-ms=50]
 *
 * Like the p2p workload, the run leaves its accounts and group behind; reset the lab to
 * clear them. Console output and artifacts contain no credentials or session tokens.
 */

const labDir = dirname(fileURLToPath(import.meta.url));
const artifactDir = join(labDir, 'runtime', 'join-latency');
const artifactDisplayPath = join(
  'dev',
  'federation-lab',
  'runtime',
  'join-latency',
);

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function parseOptions(argv) {
  const valued = new Set([
    'prefix',
    'applicant',
    'owner',
    'window-timeout-ms',
    'poll-interval-ms',
  ]);
  const options = {
    prefix: 'join',
    applicant: 'alpha',
    owner: 'bravo',
    windowTimeoutMs: 30_000,
    pollIntervalMs: 50,
  };
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      console.log(
        'options: --prefix=<a-z0-9- prefix, max 10> --applicant=<node name> ' +
          '--owner=<node name> --window-timeout-ms=<int> --poll-interval-ms=<int>',
      );
      process.exit(0);
    }
    const equals = argument.indexOf('=');
    if (!argument.startsWith('--') || equals === -1) {
      throw new Error(`unknown option: ${argument}`);
    }
    const name = argument.slice(2, equals);
    if (!valued.has(name)) throw new Error(`unknown option: ${argument}`);
    const camel = name.replace(/-([a-z])/g, (_, character) =>
      character.toUpperCase(),
    );
    options[camel] = argument.slice(equals + 1);
  }
  if (!/^[a-z][a-z0-9-]{0,9}$/.test(options.prefix)) {
    throw new Error(
      '--prefix must start with a lowercase letter and contain at most 10 lowercase letters, digits, or hyphens',
    );
  }
  for (const name of ['windowTimeoutMs', 'pollIntervalMs']) {
    options[name] = Number(options[name]);
    if (!Number.isInteger(options[name]) || options[name] < 1) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  if (options.applicant === options.owner) {
    throw new Error(
      '--applicant and --owner must name two different lab nodes',
    );
  }
  return options;
}

const options = parseOptions(process.argv.slice(2));
const applicantNode = federationLabNode(options.applicant);
const ownerNode = federationLabNode(options.owner);

const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
if (!adminPassword) {
  throw new Error(
    'ADMIN_BOOTSTRAP_PASSWORD is required in the repository .env',
  );
}

async function assertLabReady() {
  await Promise.all(
    [applicantNode, ownerNode].map(async (node) => {
      let response;
      try {
        response = await fetch(`${node.backendBaseUrl}/api/v1/client/compat`, {
          signal: AbortSignal.timeout(3_000),
        });
      } catch (error) {
        throw new Error(
          `${node.domain} is not reachable at ${node.backendBaseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `${node.domain} client compatibility returned HTTP ${response.status}`,
        );
      }
    }),
  );
}

// Envelope handling mirroring p2p/api-actors.mjs, but exposing per-request duration so the
// admission HTTP time can be reported.
async function readEnvelope(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${operation} returned non-JSON (HTTP ${response.status})`);
  }
  if (!response.ok || body?.code !== 0) {
    const requestId = response.headers.get('x-request-id');
    throw new Error(
      `${operation} failed: HTTP ${response.status} code=${body?.code ?? 'unknown'} message=${body?.message ?? 'unknown'}${requestId ? ` requestId=${requestId}` : ''}`,
    );
  }
  return body.data;
}

async function timedPost(node, path, token, body, operation) {
  const startedAt = performance.now();
  const response = await fetch(`${node.backendBaseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await readEnvelope(response, operation);
  return { data, durationMs: round1(performance.now() - startedAt) };
}

async function getJson(node, path, token, operation) {
  const response = await fetch(`${node.backendBaseUrl}/api/v1${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  return readEnvelope(response, operation);
}

/** Minimal SSE reader for GET /api/v1/events. Frames are `event: <name>\ndata: <JSON>\n\n`
 *  with a named `ping` heartbeat; HELLO carries the connect-time feed cursors. */
class EventStream {
  events = [];
  helloPayload = null;
  #node;
  #controller;
  #buffer = '';
  #closed = false;
  #helloResolve;
  #helloReject;
  #hello = new Promise((resolvePromise, rejectPromise) => {
    this.#helloResolve = resolvePromise;
    this.#helloReject = rejectPromise;
  });
  onEvent = null;

  static async connect({ node, token, timeoutMs = 15_000 }) {
    const controller = new AbortController();
    let response;
    try {
      response = await fetch(`${node.backendBaseUrl}/api/v1/events`, {
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `${node.domain}: events stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || !response.body) {
      controller.abort();
      throw new Error(
        `${node.domain}: events stream returned HTTP ${response.status}`,
      );
    }
    const stream = new EventStream(node, controller, response.body);
    const timeout = sleep(timeoutMs).then(() => {
      throw new Error(
        `${node.domain}: events stream opened but no HELLO arrived`,
      );
    });
    try {
      await Promise.race([stream.#hello, timeout]);
    } catch (error) {
      stream.close();
      throw error;
    }
    return stream;
  }

  constructor(node, controller, body) {
    this.#node = node;
    this.#controller = controller;
    void this.#pump(body);
  }

  get hello() {
    return this.#hello;
  }

  async #pump(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buffer = (
          this.#buffer + decoder.decode(value, { stream: true })
        ).replaceAll('\r\n', '\n');
        let separator;
        while ((separator = this.#buffer.indexOf('\n\n')) !== -1) {
          const frame = this.#buffer.slice(0, separator);
          this.#buffer = this.#buffer.slice(separator + 2);
          this.#handleFrame(frame);
        }
      }
      if (!this.#closed) {
        this.#helloReject(
          new Error(`${this.#node.domain}: events stream closed`),
        );
      }
    } catch (error) {
      if (!this.#closed) {
        this.#helloReject(
          new Error(
            `${this.#node.domain}: events stream failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }

  #handleFrame(frame) {
    const lines = frame.split('\n');
    const event = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    if (!event || event === 'ping') return;
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    let parsed = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      // The probe only consumes JSON frames; keep scanning the stream.
    }
    const record = { event, data: parsed, at: performance.now() };
    this.events.push(record);
    if (event === 'HELLO') {
      this.helloPayload = parsed;
      this.#helloResolve(parsed);
    }
    this.onEvent?.(record);
  }

  close() {
    this.#closed = true;
    this.#controller.abort();
  }
}

const terminalStatuses = new Set([
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED',
]);

async function waitForTaskTerminal({ admin, taskId, description, deadline }) {
  for (;;) {
    if (
      performance.now() >
      (typeof deadline === 'function' ? deadline() : deadline)
    ) {
      throw new Error(`timed out waiting for ${description} (task ${taskId})`);
    }
    const page = await admin.durableTasks({ take: 200 });
    const task = (page.list ?? []).find(
      (candidate) => String(candidate.id) === String(taskId),
    );
    if (task) {
      if (terminalStatuses.has(task.status)) return task;
    }
    await sleep(50);
  }
}

function serverTaskDurationMs(task) {
  if (!task?.startedAt || !task?.completedAt) return null;
  return round1(
    new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime(),
  );
}

async function findGroupAddress({ owner, groupId, deadline }) {
  // The group's federation address lives in the owner's THREAD_STATE snapshot (the profile of
  // the minted '!'-prefixed group account).
  let after = 0;
  for (;;) {
    if (performance.now() > deadline)
      throw new Error('timed out reading the owner state feed');
    const page = await getJson(
      ownerNode,
      `/user/state-feed?mode=full&after=${after}&take=200`,
      owner.token,
      `${ownerNode.domain}: read state feed`,
    );
    for (const item of page.items ?? []) {
      if (
        item.eventType === 'THREAD_STATE' &&
        item.body?.type === 'GROUP' &&
        item.body?.threadId === groupId
      ) {
        return {
          account: item.body.profile.account,
          domain: item.body.profile.domain,
        };
      }
    }
    if (
      !page.hasMore ||
      !Number.isInteger(page.scannedThrough) ||
      page.scannedThrough <= after
    ) {
      break;
    }
    after = page.scannedThrough;
  }
  throw new Error(
    `group ${groupId} has no THREAD_STATE snapshot in the owner state feed`,
  );
}

async function resolveGroupFromApplicant({ applicant, group, deadline }) {
  const operation = `${applicantNode.domain}: resolve group ${group.account}@${ownerNode.domain}`;
  let lastError;
  while (performance.now() < deadline) {
    try {
      const resolved = await applicant.resolveFederatedUser({
        account: group.account,
        domain: ownerNode.domain,
      });
      if (resolved?.user?.account === group.account) return resolved;
      lastError = new Error(
        `${operation}: unexpected payload ${JSON.stringify(resolved ?? null)}`,
      );
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error(`${operation} timed out`);
}

async function waitForJoinRequest({
  owner,
  groupId,
  applicantAccount,
  deadline,
}) {
  let polls = 0;
  for (;;) {
    if (performance.now() > deadline) {
      throw new Error(
        `join request from ${applicantAccount} never appeared on ${ownerNode.domain}`,
      );
    }
    polls += 1;
    const page = await owner.post(
      '/group/join-requests',
      { groupId },
      'list pending join requests',
    );
    const request = (page.data ?? []).find(
      (candidate) =>
        candidate.account === applicantAccount &&
        candidate.status === 'REQUESTED',
    );
    if (request) return { requestId: request.id, polls };
    await sleep(100);
  }
}

/** The GROUP_JOINED system message carrying the applicant as its member. The member domain is
 *  'local' in the member's home namespace and the origin domain on remote mirrors. */
function findJoinSystemMessage(messages, applicantAccount, applicantDomain) {
  for (const message of messages ?? []) {
    if (message.contentType !== 'SYSTEM' || typeof message.content !== 'string')
      continue;
    let content;
    try {
      content = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (content?.type !== 'GROUP_JOINED') continue;
    const member = content.member;
    if (
      member?.account === applicantAccount &&
      (member.domain === 'local' || member.domain === applicantDomain)
    ) {
      return message;
    }
  }
  return null;
}

/** A client that stays idle until an SSE wake-up arrives and then pulls exactly like the
 *  shipped apps: THREAD_FEED_UPDATED → POST /thread-feed, STATE_FEED_UPDATED →
 *  GET /user/state-feed (delta). Every changed GROUP thread is read once through
 *  POST /query-messages until the GROUP_JOINED system message appears. Concurrent wake-ups
 *  coalesce into one follow-up pull, mirroring the client's in-flight guard.
 *
 *  `milestone` settles with the system message; `membership` settles as soon as the state
 *  feed exposes the group thread for `groupAccount` (the applicant-side convergence marker:
 *  a mirrored membership can become visible without any local system message). */
class SseDrivenFeedClient {
  pulls = 0;
  label;
  #user;
  #memberAccount;
  #memberDomain;
  #groupAccount;
  #threadCursor;
  #stateCursor;
  #settle;
  #membershipSettle;
  #membershipSettled = false;
  #settled = false;
  #draining = false;
  #wakePending = false;
  #timeout;

  constructor({
    label,
    user,
    memberAccount,
    memberDomain,
    groupAccount,
    hello,
    timeoutMs,
  }) {
    this.label = label;
    this.#user = user;
    this.#memberAccount = memberAccount;
    this.#memberDomain = memberDomain;
    this.#groupAccount = groupAccount ?? null;
    this.#threadCursor = hello?.threadFeedEndId ?? 0;
    this.#stateCursor = hello?.stateFeedEndId ?? 0;
    this.milestone = new Promise((resolvePromise, rejectPromise) => {
      this.#settle = { resolvePromise, rejectPromise };
    });
    this.membership = new Promise((resolvePromise) => {
      this.#membershipSettle = resolvePromise;
    });
    this.#timeout = setTimeout(() => {
      this.#fail(
        new Error(
          `${label}: no GROUP_JOINED system message within ${timeoutMs} ms of SSE-driven pulls`,
        ),
      );
    }, timeoutMs);
  }

  handleFrame(frame) {
    if (this.#settled && this.#membershipSettled) return;
    if (
      frame.event === 'THREAD_FEED_UPDATED' ||
      frame.event === 'STATE_FEED_UPDATED'
    ) {
      void this.#wake();
    }
  }

  dispose() {
    clearTimeout(this.#timeout);
    this.#settled = true;
    this.#membershipSettled = true;
  }

  #found(threadId, message) {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timeout);
    this.#settle.resolvePromise({ threadId, message });
  }

  #fail(error) {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timeout);
    this.#settle.rejectPromise(error);
  }

  #membershipSeen(threadId, role) {
    if (this.#membershipSettled) return;
    this.#membershipSettled = true;
    this.#membershipSettle({ threadId, role });
  }

  /** One drain at a time; wake-ups that arrive during a drain coalesce into one more pass. */
  async #wake() {
    if (this.#draining) {
      this.#wakePending = true;
      return;
    }
    this.#draining = true;
    try {
      do {
        this.#wakePending = false;
        await this.#pullThreadFeed();
        if (this.#settled) return;
        await this.#pullStateFeed();
      } while (this.#wakePending && !this.#settled);
    } catch {
      // A failed pull (transport, throttle) is recovered by the next wake-up, like the client.
    } finally {
      this.#draining = false;
    }
    if (this.#wakePending && !this.#settled) void this.#wake();
  }

  async #pullThreadFeed() {
    this.pulls += 1;
    const page = await this.#user.post(
      '/thread-feed',
      { after: this.#threadCursor, take: 200 },
      'pull thread feed delta',
    );
    if (Number.isInteger(page.threadFeedEndId)) {
      this.#threadCursor = page.threadFeedEndId;
    }
    for (const item of page.items ?? []) {
      await this.#readThread(item.threadId);
      if (this.#settled) return;
    }
  }

  async #pullStateFeed() {
    this.pulls += 1;
    const page = await getJson(
      this.#user.node,
      `/user/state-feed?mode=delta&after=${this.#stateCursor}&take=200`,
      this.#user.token,
      'pull state feed delta',
    );
    if (Number.isInteger(page.scannedThrough)) {
      this.#stateCursor = page.scannedThrough;
    }
    for (const item of page.items ?? []) {
      if (item.eventType !== 'THREAD_STATE' || item.body?.type !== 'GROUP') {
        continue;
      }
      if (
        this.#groupAccount !== null &&
        item.body.profile?.account === this.#groupAccount
      ) {
        this.#membershipSeen(item.body.threadId, item.body.role ?? null);
      }
      await this.#readThread(item.body.threadId);
      if (this.#settled) return;
    }
  }

  async #readThread(threadId) {
    const page = await this.#user.post(
      '/query-messages',
      { threadId, after: 0, take: 50 },
      'read conversation messages',
    );
    const found = findJoinSystemMessage(
      page.messages,
      this.#memberAccount,
      this.#memberDomain,
    );
    if (found) this.#found(threadId, found);
  }
}

async function main() {
  await assertLabReady();
  console.log(
    `[join-latency] lab ready: applicant node ${applicantNode.domain}, owner node ${ownerNode.domain}`,
  );

  const admins = new Map(
    await Promise.all(
      [applicantNode, ownerNode].map(async (node) => [
        node.name,
        await LabAdminActor.login({ node, password: adminPassword }),
      ]),
    ),
  );
  const applicantAdmin = admins.get(applicantNode.name);
  const ownerAdmin = admins.get(ownerNode.name);

  const stamp = Date.now().toString(36);
  const applicantAccount = `${options.prefix}-a-${stamp}`;
  const ownerAccount = `${options.prefix}-b-${stamp}`;

  const setup = [];
  const setupStep = async (label, work) => {
    const startedAt = performance.now();
    const result = await work();
    const durationMs = round1(performance.now() - startedAt);
    setup.push({ label, durationMs });
    console.log(`[setup] ${label}: ${durationMs} ms`);
    return result;
  };

  const applicant = await setupStep('provision applicant account', () =>
    applicantAdmin.createAndLoginUser({
      account: applicantAccount,
      name: `Apply ${stamp}`,
    }),
  );
  const owner = await setupStep('provision group owner account', () =>
    ownerAdmin.createAndLoginUser({
      account: ownerAccount,
      name: `Owner ${stamp}`,
    }),
  );

  const created = await setupStep('create group on owner node', () =>
    owner.post('/group/create', {
      name: `Latency ${stamp}`,
      description: 'group join latency',
    }),
  );
  const groupId = created.groupId;
  if (!Number.isInteger(groupId)) {
    throw new Error(
      `group create returned no thread id: ${JSON.stringify(created)}`,
    );
  }

  const group = await setupStep('read group federation address', () =>
    findGroupAddress({ owner, groupId, deadline: performance.now() + 10_000 }),
  );
  const groupAddress = `${group.account}@${ownerNode.domain}`;
  console.log(`[setup] group ${groupId} addressed as ${groupAddress}`);

  const resolved = await setupStep('resolve group from applicant node', () =>
    resolveGroupFromApplicant({
      applicant,
      group,
      deadline: performance.now() + 30_000,
    }),
  );

  const application = await setupStep('submit join application', () =>
    timedPost(
      applicantNode,
      '/relationship/request',
      applicant.token,
      {
        account: group.account,
        domain: ownerNode.domain,
        note: `join latency ${stamp}`,
        displayName: resolved.user.name,
      },
      'submit group join application',
    ),
  );

  const setupDeadline = performance.now() + 30_000;
  const applicationTask = await setupStep(
    'application task terminal on applicant node',
    () =>
      waitForTaskTerminal({
        admin: applicantAdmin,
        taskId: application.data.taskId,
        description: 'join application task',
        deadline: setupDeadline,
      }),
  );
  if (applicationTask.status !== 'SUCCEEDED') {
    throw new Error(
      `join application task ended ${applicationTask.status}: ${applicationTask.lastError ?? `resultCode ${applicationTask.resultCode}`}`,
    );
  }
  const joinRequest = await setupStep(
    'join request visible on owner node',
    () =>
      waitForJoinRequest({
        owner,
        groupId,
        applicantAccount,
        deadline: setupDeadline,
      }),
  );

  // Streams open before the window so the HELLO cursors are the "before" baseline and no hint
  // from the accept call can be missed.
  const ownerEvents = await EventStream.connect({
    node: ownerNode,
    token: owner.token,
  });
  const applicantEvents = await EventStream.connect({
    node: applicantNode,
    token: applicant.token,
  });

  const timeline = [];
  let windowStartAt = null;
  const record = (node, label, details = {}) => {
    timeline.push({
      node,
      label,
      atMs: round1(performance.now() - windowStartAt),
      ...details,
    });
  };

  // One feed client per node, built on the HELLO cursors: it stays idle until an SSE wake-up
  // arrives, then pulls the feeds exactly like the shipped apps do.
  const ownerClient = new SseDrivenFeedClient({
    label: `${ownerNode.name} (owner)`,
    user: owner,
    memberAccount: applicant.account,
    memberDomain: applicantNode.domain,
    groupAccount: group.account,
    hello: ownerEvents.helloPayload,
    timeoutMs: options.windowTimeoutMs,
  });
  const applicantClient = new SseDrivenFeedClient({
    label: `${applicantNode.name} (applicant)`,
    user: applicant,
    memberAccount: applicant.account,
    memberDomain: applicantNode.domain,
    groupAccount: group.account,
    hello: applicantEvents.helloPayload,
    timeoutMs: options.windowTimeoutMs,
  });

  const firstHint = new Map();
  for (const [stream, nodeName, client] of [
    [ownerEvents, ownerNode.name, ownerClient],
    [applicantEvents, applicantNode.name, applicantClient],
  ]) {
    stream.onEvent = (frame) => {
      if (windowStartAt === null) return;
      if (
        frame.event === 'THREAD_FEED_UPDATED' ||
        frame.event === 'STATE_FEED_UPDATED'
      ) {
        if (!firstHint.has(`${nodeName}:${frame.event}`)) {
          firstHint.set(`${nodeName}:${frame.event}`, true);
          record(nodeName, `sse ${frame.event}`, { payload: frame.data });
        }
        client.handleFrame(frame);
      }
    };
  }

  // Durable tasks created during the window, per node: shows what each node had to run.
  // These watchers are advisory: they stop when the measured milestones complete, so they must
  // never fail the run (their errors are reported as notes instead).
  const taskWatchers = new Map();
  let watchersStopped = false;
  let watcherPromises = [];
  const startTaskWatchers = () => {
    for (const [nodeName, admin] of [
      [ownerNode.name, ownerAdmin],
      [applicantNode.name, applicantAdmin],
    ]) {
      taskWatchers.set(nodeName, {
        admin,
        known: null,
        tasks: new Map(),
        reported: new Set(),
        error: null,
      });
    }
    watcherPromises = [...taskWatchers].map(async ([nodeName, watcher]) => {
      const before = await watcher.admin.durableTasks({ take: 200 });
      // Tasks existing before the window are not this window's work.
      watcher.known = new Set(
        (before.list ?? []).map((task) => String(task.id)),
      );
      try {
        while (
          !watchersStopped &&
          performance.now() < windowStartAt + options.windowTimeoutMs
        ) {
          const page = await watcher.admin.durableTasks({ take: 100 });
          for (const task of page.list ?? []) {
            const id = String(task.id);
            if (watcher.known.has(id)) continue;
            watcher.tasks.set(id, task);
            if (!watcher.reported.has(id)) {
              watcher.reported.add(id);
              record(nodeName, 'durable task observed', {
                taskId: id,
                taskType: task.taskType,
              });
            }
          }
          await sleep(options.pollIntervalMs);
        }
      } catch (error) {
        watcher.error = error;
      }
    });
  };

  let windowError = null;
  let applicantNoticeGap = null;
  try {
    // ===== measured window: the owner allows the join =====
    windowStartAt = performance.now();
    startTaskWatchers();
    const accept = await timedPost(
      ownerNode,
      '/group/join-request/accept',
      owner.token,
      { groupId, requestId: joinRequest.requestId },
      'accept group join request',
    );
    record(ownerNode.name, 'accept admitted', {
      taskId: accept.data.taskId,
      httpMs: accept.durationMs,
    });

    const ownerTaskTerminal = waitForTaskTerminal({
      admin: ownerAdmin,
      taskId: accept.data.taskId,
      description: 'accept task',
      deadline: () => windowStartAt + options.windowTimeoutMs,
    }).then((task) => {
      record(ownerNode.name, `accept task ${task.status}`, {
        taskId: String(task.id),
        taskType: task.taskType,
        serverExecutionMs: serverTaskDurationMs(task),
      });
      if (task.status !== 'SUCCEEDED') {
        throw new Error(
          `accept task ended ${task.status}: ${task.lastError ?? `resultCode ${task.resultCode}`}`,
        );
      }
    });
    const ownerMessage = ownerClient.milestone.then(({ threadId, message }) => {
      record(ownerNode.name, 'system message visible', {
        threadId,
        seq: message.seq,
        contentType: message.contentType,
        pulls: ownerClient.pulls,
      });
    });
    const applicantMessage = applicantClient.milestone.then(
      ({ threadId, message }) => {
        record(applicantNode.name, 'system message visible', {
          threadId,
          seq: message.seq,
          contentType: message.contentType,
          pulls: applicantClient.pulls,
        });
      },
    );
    // The mirrored membership (THREAD_STATE, role MEMBER) is the applicant node's own
    // convergence marker; the federated join notice may legitimately never be written there.
    const applicantMembership = applicantClient.membership.then(
      ({ threadId, role }) => {
        record(applicantNode.name, 'membership visible', {
          threadId,
          role,
          pulls: applicantClient.pulls,
        });
      },
    );

    const results = await Promise.allSettled([
      ownerTaskTerminal,
      ownerMessage,
      applicantMessage,
      applicantMembership,
    ]);
    for (const [index, result] of results.entries()) {
      // The applicant-side system message is best effort (see the report note).
      const optional = index === 2;
      if (result.status === 'rejected' && !optional) throw result.reason;
      if (result.status === 'rejected' && optional) {
        applicantNoticeGap = result.reason;
      }
    }
  } catch (error) {
    // Keep going: the partial timeline is exactly what a failing run is for.
    windowError = error;
  } finally {
    watchersStopped = true;
    ownerClient.dispose();
    applicantClient.dispose();
    ownerEvents.close();
    applicantEvents.close();
    await Promise.allSettled(watcherPromises);
  }

  const elapsedTotalMs = round1(performance.now() - windowStartAt);

  if (windowError) {
    console.error(`[join-latency] window failed: ${windowError.message}`);
  }
  console.log(
    '\n=== window: POST /group/join-request/accept (group owner) ===',
  );
  const admittedAtMs = timeline.find(
    (entry) => entry.label === 'accept admitted',
  )?.atMs;
  for (const entry of timeline.slice().sort((a, b) => a.atMs - b.atMs)) {
    const details = Object.entries(entry)
      .filter(([key]) => !['node', 'label', 'atMs'].includes(key))
      .map(
        ([key, value]) =>
          `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`,
      )
      .join(' ');
    // A hint that lands before the accept response was admitted by earlier writes
    // (the state-feed push coalescer and the 1 s head poller flush late).
    const staleHint =
      entry.label.startsWith('sse ') &&
      admittedAtMs !== undefined &&
      entry.atMs < admittedAtMs
        ? ' [pre-admission wake]'
        : '';
    console.log(
      `  ${entry.node.padEnd(ownerNode.name.length + 2)} +${String(entry.atMs).padStart(8)} ms  ${entry.label}${staleHint}${details ? `  (${details})` : ''}`,
    );
  }

  const visible = (nodeName) =>
    timeline.find(
      (entry) =>
        entry.node === nodeName && entry.label === 'system message visible',
    );
  const ownerVisible = visible(ownerNode.name);
  const applicantVisible = visible(applicantNode.name);
  console.log('\n=== totals ===');
  if (ownerVisible) {
    console.log(
      `  accept -> owner node ${ownerNode.name} system message visible (threadId ${ownerVisible.threadId}): ${ownerVisible.atMs} ms`,
    );
  }
  if (applicantVisible) {
    console.log(
      `  accept -> applicant node ${applicantNode.name} system message visible (threadId ${applicantVisible.threadId}): ${applicantVisible.atMs} ms (end to end)`,
    );
  }
  const membershipVisible = timeline.find(
    (entry) =>
      entry.node === applicantNode.name && entry.label === 'membership visible',
  );
  if (membershipVisible) {
    console.log(
      `  accept -> applicant node ${applicantNode.name} membership visible (threadId ${membershipVisible.threadId}, role ${membershipVisible.role}): ${membershipVisible.atMs} ms`,
    );
  }
  console.log(`  window closed after: ${elapsedTotalMs} ms`);
  for (const [nodeName, watcher] of taskWatchers) {
    if (watcher.error) {
      console.warn(
        `[join-latency] note: ${nodeName} task watcher stopped early: ${watcher.error.message}`,
      );
    }
  }
  if (applicantNoticeGap) {
    console.warn(
      `[join-latency] note: the applicant node never served the GROUP_JOINED system message within the window: ${applicantNoticeGap.message}`,
    );
  }

  const artifact = {
    recordedAt: new Date().toISOString(),
    error: windowError ? windowError.message : null,
    applicantNoticeGap: applicantNoticeGap ? applicantNoticeGap.message : null,
    options,
    nodes: {
      applicant: { name: applicantNode.name, domain: applicantNode.domain },
      owner: { name: ownerNode.name, domain: ownerNode.domain },
    },
    group: { groupId, address: groupAddress },
    joinRequest: { requestId: joinRequest.requestId, polls: joinRequest.polls },
    application: {
      taskId: application.data.taskId,
      admissionMs: application.durationMs,
    },
    setup,
    windowClosedAfterMs: elapsedTotalMs,
    clientPulls: {
      [ownerNode.name]: ownerClient.pulls,
      [applicantNode.name]: applicantClient.pulls,
    },
    timeline,
    sseEvents: {
      [ownerNode.name]: ownerEvents.events.map(({ event, data }) => ({
        event,
        data,
      })),
      [applicantNode.name]: applicantEvents.events.map(({ event, data }) => ({
        event,
        data,
      })),
    },
    windowTasks: Object.fromEntries(
      [...taskWatchers].map(([nodeName, watcher]) => [
        nodeName,
        [...watcher.tasks.values()].map((task) => ({
          id: String(task.id),
          taskType: task.taskType,
          status: task.status,
          serverExecutionMs: serverTaskDurationMs(task),
          lastError: task.lastError ?? null,
        })),
      ]),
    ),
  };
  await mkdir(artifactDir, { recursive: true });
  const artifactName = `run-${Date.now()}.json`;
  await writeFile(
    join(artifactDir, artifactName),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  console.log(`\nartifact: ${join(artifactDisplayPath, artifactName)}`);
  if (windowError) throw windowError;
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `[join-latency] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
