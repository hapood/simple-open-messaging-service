import { federationLabNode, federationLabNodes } from '../topology.mjs';

const API_PREFIX = '/api/v1';
const PROFILE_AVATAR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWOwLbv2HwAFBgKJNk+bNAAAAABJRU5ErkJggg==';

export class LabApiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'LabApiError';
    this.details = details;
  }
}

async function readEnvelope(response, operation) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new LabApiError(`${operation} returned non-JSON`, {
      status: response.status,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok || body?.code !== 0) {
    const requestId = response.headers.get('x-request-id');
    throw new LabApiError(
      `${operation} failed: HTTP ${response.status} code=${body?.code ?? 'unknown'} message=${body?.message ?? 'unknown'}${requestId ? ` requestId=${requestId}` : ''}`,
      {
        status: response.status,
        code: body?.code,
        message: body?.message,
        data: body?.data,
        requestId,
      },
    );
  }
  return body.data;
}

async function post(node, path, options = {}) {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  if (options.adminCookie) headers.set('Cookie', options.adminCookie);
  if (options.userToken) {
    headers.set('Authorization', `Bearer ${options.userToken}`);
  }
  const response = await fetch(`${node.backendBaseUrl}${API_PREFIX}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  return { response, data: await readEnvelope(response, options.operation) };
}

async function postMultipart(node, path, { body, userToken, headers = {} }) {
  const requestHeaders = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${userToken}`,
    ...headers,
  });
  const response = await fetch(`${node.backendBaseUrl}${API_PREFIX}${path}`, {
    method: 'POST',
    headers: requestHeaders,
    body,
    signal: AbortSignal.timeout(35_000),
  });
  return readEnvelope(response, `${node.domain}: multipart ${path}`);
}

async function get(node, path, options = {}) {
  const headers = new Headers({ Accept: options.accept ?? 'application/json' });
  if (options.userToken) {
    headers.set('Authorization', `Bearer ${options.userToken}`);
  }
  const response = await fetch(`${node.backendBaseUrl}${API_PREFIX}${path}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 35_000),
  });
  return response;
}

function parseSseTerminal(text, operation) {
  const frames = text.split(/\r?\n\r?\n/);
  for (const frame of frames) {
    const event = frame
      .split(/\r?\n/)
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim();
    if (event !== 'resolved' && event !== 'failed') continue;
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new LabApiError(`${operation} returned invalid SSE data`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (event === 'failed') {
      throw new LabApiError(`${operation} failed`, parsed);
    }
    return parsed;
  }
  throw new LabApiError(`${operation} returned no terminal SSE event`, {});
}

function adminCookie(response) {
  const setCookie = response.headers.get('set-cookie') ?? '';
  const match = /(?:^|[,;]\s*)admin_session=([^;,]+)/.exec(setCookie);
  if (!match) {
    throw new LabApiError('admin login did not return admin_session cookie', {
      status: response.status,
    });
  }
  return `admin_session=${match[1]}`;
}

export class LabUserActor {
  constructor({ node, id, account, token }) {
    this.node = node;
    this.id = id;
    this.account = account;
    this.domain = node.domain;
    this.address = `${account}@${node.domain}`;
    this.token = token;
  }

  async post(path, body = {}, operation = `user ${path}`) {
    const result = await post(this.node, path, {
      body,
      userToken: this.token,
      operation: `${this.address}: ${operation}`,
    });
    return result.data;
  }

  async myProfile() {
    return this.post('/user/my-profile', {}, 'load own profile');
  }

  async updateProfile({ name, bio, avatar = 'KEEP' }) {
    return this.post(
      '/user/update-profile',
      {
        name,
        bio,
        ...(avatar === 'SET'
          ? { avatarBase64: PROFILE_AVATAR_BASE64 }
          : avatar === 'REMOVE'
            ? { avatarBase64: null }
            : {}),
      },
      'update own profile',
    );
  }

  async uploadAvatar() {
    const body = new FormData();
    body.set(
      'file',
      new Blob([Buffer.from(PROFILE_AVATAR_BASE64, 'base64')], {
        type: 'image/png',
      }),
      'federation-profile.png',
    );
    const result = await postMultipart(this.node, '/upload/avatar', {
      body,
      userToken: this.token,
    });
    if (typeof result?.avatar !== 'string') {
      throw new LabApiError('avatar upload returned no path', {
        node: this.node.domain,
      });
    }
    return result.avatar;
  }

  async resolveFederatedUser({ account, domain }) {
    const operation = `${this.address}: resolve ${account}@${domain}`;
    const query = new URLSearchParams({ account, domain });
    const response = await get(
      this.node,
      `/user/resolve-federated-stream?${query}`,
      {
        userToken: this.token,
        accept: 'text/event-stream',
      },
    );
    if (!response.ok) {
      throw new LabApiError(`${operation} returned HTTP ${response.status}`, {
        status: response.status,
      });
    }
    return parseSseTerminal(await response.text(), operation);
  }

  async resolveProfile(selector) {
    return this.post(
      '/user/profile-resolution',
      selector,
      `resolve profile ${JSON.stringify(selector)}`,
    );
  }

  async forwardBundle(bundleId) {
    const response = await get(
      this.node,
      `/forward-bundles/${encodeURIComponent(bundleId)}`,
      { userToken: this.token },
    );
    return readEnvelope(response, `read forward bundle ${bundleId}`);
  }

  async queryStateFeed({ mode = 'full', after = 0, take = 200, through }) {
    const query = new URLSearchParams({
      mode,
      after: String(after),
      take: String(take),
    });
    if (through !== undefined) query.set('through', String(through));
    const operation = `${this.address}: query client state feed`;
    const response = await get(this.node, `/user/state-feed?${query}`, {
      userToken: this.token,
    });
    return readEnvelope(response, operation);
  }

  async queryUser({ account, domain }) {
    const users = await this.post(
      '/user/query',
      { addresses: [{ account, domain }] },
      `query ${account}@${domain}`,
    );
    return users.find(
      (user) => user.account === account && user.domain === domain,
    );
  }

  async threadWithUser(userId) {
    return this.post(
      '/thread/by-user-id',
      { userId },
      `look up P2P thread with user ${userId}`,
    );
  }

  async createGroup({ name, description = '', avatar }) {
    return this.post(
      '/group/create',
      { name, description, ...(avatar ? { avatar } : {}) },
      `create group ${name}`,
    );
  }

  async updateGroup({ groupId, name, description, avatar }) {
    return this.post(
      '/group/update',
      {
        groupId,
        name,
        description,
        ...(avatar !== undefined ? { avatar } : {}),
      },
      `update group ${groupId}`,
    );
  }

  async sendText(threadId, content, clientMessageId) {
    return this.post(
      '/send-message',
      {
        threadId,
        content: JSON.stringify({ text: content }),
        contentType: 'PURE_TEXT',
        clientMessageId,
      },
      `send message ${clientMessageId}`,
    );
  }

  async sendMedia({ threadId, clientMessageId, parts }) {
    const contentType = parts.length === 1 ? 'FILE' : 'GALLERY';
    await this.post(
      '/send-media',
      { threadId, clientMessageId, contentType, fileCnt: parts.length },
      `stage ${contentType} message ${clientMessageId}`,
    );
    for (const [position, part] of parts.entries()) {
      const body = new FormData();
      body.set('partId', part.partId);
      body.set('position', String(position));
      body.set('intent', 'FILE');
      body.set(
        'file',
        new Blob([part.bytes], {
          type: part.mimeType ?? 'application/octet-stream',
        }),
        part.filename,
      );
      await postMultipart(this.node, '/upload', {
        body,
        userToken: this.token,
        headers: { 'x-client-message-id': clientMessageId },
      });
    }
    return this.findMessageByClientMessageId(threadId, clientMessageId);
  }

  async findMessageByClientMessageId(threadId, clientMessageId) {
    let before;
    try {
      await this.post('/query-messages', { threadId }, 'initialize history');
      throw new LabApiError('message history unexpectedly returned no cursor', {
        threadId,
      });
    } catch (error) {
      const resumeBefore = error?.details?.data?.resumeBefore;
      if (
        !(error instanceof LabApiError) ||
        error.details?.code !== 30006 ||
        !Number.isInteger(resumeBefore)
      )
        throw error;
      before = resumeBefore;
    }
    for (;;) {
      const page = await this.post(
        '/query-messages',
        { threadId, before, take: 50 },
        `resolve media message ${clientMessageId}`,
      );
      const found = page.messages?.find(
        (message) => message.clientMessageId === clientMessageId,
      );
      if (found) return found;
      if (!page.hasMore) break;
      if (
        !Number.isInteger(page.scannedThrough) ||
        page.scannedThrough >= before
      )
        throw new LabApiError('message history cursor did not retreat', {
          threadId,
          before,
          scannedThrough: page.scannedThrough,
        });
      before = page.scannedThrough;
    }
    throw new LabApiError('promoted media message was not found in history', {
      threadId,
      clientMessageId,
    });
  }

  async withdrawMessage(threadId, seq) {
    return this.post(
      '/withdraw-message',
      { threadId, seq },
      `withdraw message seq ${seq}`,
    );
  }
}

export class LabAdminActor {
  constructor({ node, account, password, cookie }) {
    this.node = node;
    this.account = account;
    this.password = password;
    this.cookie = cookie;
    this.loginInFlight = null;
  }

  static async login({ node, password, account = 'admin' }) {
    const { response } = await post(node, '/admin/login', {
      body: { account, password },
      operation: `${node.domain}: admin login`,
    });
    return new LabAdminActor({
      node,
      account,
      password,
      cookie: adminCookie(response),
    });
  }

  async post(path, body = {}, operation = `admin ${path}`) {
    const request = () =>
      post(this.node, path, {
        body,
        adminCookie: this.cookie,
        operation: `${this.node.domain}: ${operation}`,
      });
    try {
      return (await request()).data;
    } catch (error) {
      if (!(error instanceof LabApiError) || error.details?.status !== 401)
        throw error;
      await this.renewSession();
      return (await request()).data;
    }
  }

  async renewSession() {
    if (!this.loginInFlight) {
      this.loginInFlight = post(this.node, '/admin/login', {
        body: { account: this.account, password: this.password },
        operation: `${this.node.domain}: renew admin session`,
      })
        .then(({ response }) => {
          this.cookie = adminCookie(response);
        })
        .finally(() => {
          this.loginInFlight = null;
        });
    }
    await this.loginInFlight;
  }

  async createAndLoginUser({ account, name }) {
    const created = await this.post(
      '/admin/users/create',
      { account, name },
      `create user ${account}`,
    );
    if (!Number.isInteger(created?.id) || created?.account !== account) {
      throw new LabApiError('create user returned an invalid identity', {
        node: this.node.domain,
        account,
        data: created,
      });
    }
    const issued = await this.post(
      `/admin/users/${created.id}/issue-login-code`,
      {},
      `issue OTP for ${account}`,
    );
    if (typeof issued?.code !== 'string') {
      throw new LabApiError('issue login code did not return a code', {
        node: this.node.domain,
        account,
      });
    }
    const { data: loggedIn } = await post(this.node, '/auth/otp/login', {
      body: {
        account,
        code: issued.code,
        client: 'app',
        device: `federation-lab-p2p:${this.node.name}:${account}`,
      },
      operation: `${this.node.domain}: OTP login ${account}`,
    });
    if (typeof loggedIn?.session_token !== 'string') {
      throw new LabApiError('OTP login did not return a session token', {
        node: this.node.domain,
        account,
      });
    }
    return new LabUserActor({
      node: this.node,
      id: created.id,
      account,
      token: loggedIn.session_token,
    });
  }

  async authRateLimitConfiguration() {
    const snapshot = await this.post(
      '/admin/rate-limits',
      {},
      'read authentication rate limits',
    );
    if (!Array.isArray(snapshot?.policies)) {
      throw new LabApiError('rate-limit snapshot did not contain policies', {
        node: this.node.domain,
      });
    }
    return snapshot.policies.map(({ policy, mode, buckets }) => ({
      policy,
      mode,
      buckets: buckets.map(({ name, ratePerSecond, burst }) => ({
        name,
        ratePerSecond,
        burst,
      })),
    }));
  }

  async setAuthRateLimitConfiguration(configuration) {
    return this.post(
      '/admin/rate-limits/configuration',
      configuration,
      'replace authentication rate limits',
    );
  }

  async settings() {
    return this.post('/admin/settings', {}, 'read runtime settings');
  }

  async setUserQuotaDefaults(configuration) {
    return this.post(
      '/admin/settings/user-quota-defaults',
      configuration,
      'replace user quota defaults',
    );
  }

  async setFederationQuotaDefaults(configuration) {
    return this.post(
      '/admin/settings/federation-quota-defaults',
      configuration,
      'replace federation quota defaults',
    );
  }

  async durableTaskActivity() {
    const queryMs = {};
    const [pending, processing, failed] = await Promise.all(
      ['PENDING', 'PROCESSING', 'FAILED'].map(
        async (status) => {
          const startedAt = performance.now();
          const result = await this.durableTasks({
            status,
            take: status === 'PENDING' ? 1 : 200,
          });
          // Includes response decoding and any session renewal/retry.
          queryMs[status] = Math.round(performance.now() - startedAt);
          return result;
        },
      ),
    );
    return {
      queryMs,
      pendingCount: pending.total,
      processing: processing.list ?? [],
      failedCount: failed.total,
      failed: failed.list ?? [],
    };
  }

  async durableTasks({ status, skip = 0, take = 200 } = {}) {
    return this.post(
      '/admin/durable-tasks',
      { ...(status ? { status } : {}), skip, take },
      `read${status ? ` ${status.toLowerCase()}` : ''} durable tasks`,
    );
  }

  async durableTaskStatuses(taskIds) {
    const wanted = new Set([...taskIds].map(String));
    const found = new Map();
    let skip = 0;
    while (wanted.size > found.size) {
      const page = await this.durableTasks({ skip, take: 200 });
      for (const task of page.list ?? []) {
        const id = String(task.id);
        if (wanted.has(id)) found.set(id, task);
      }
      skip += page.list?.length ?? 0;
      if (!page.list?.length || skip >= page.total) break;
    }
    return found;
  }
}

export class FederationLabActors {
  constructor(nodes) {
    this.nodes = nodes;
  }

  static async connect({ adminPassword, adminAccount = 'admin' }) {
    if (!adminPassword) {
      throw new Error(
        'ADMIN_BOOTSTRAP_PASSWORD is required to connect federation lab administrators',
      );
    }
    const admins = await Promise.all(
      federationLabNodes.map((node) =>
        LabAdminActor.login({
          node,
          account: adminAccount,
          password: adminPassword,
        }),
      ),
    );
    return new FederationLabActors(
      new Map(
        federationLabNodes.map((node, index) => [
          node.name,
          {
            topology: node,
            admin: admins[index],
            users: new Map(),
          },
        ]),
      ),
    );
  }

  node(name) {
    federationLabNode(name);
    const node = this.nodes.get(name);
    if (!node) throw new Error(`federation lab actor node missing: ${name}`);
    return node;
  }

  async createAndLoginUser(nodeName, input) {
    const node = this.node(nodeName);
    if (node.users.has(input.account)) {
      throw new Error(
        `${node.topology.domain}: duplicate actor ${input.account}`,
      );
    }
    const user = await node.admin.createAndLoginUser(input);
    node.users.set(user.account, user);
    return user;
  }

  user(address) {
    const separator = address.lastIndexOf('@');
    if (separator <= 0)
      throw new Error(`invalid federation address: ${address}`);
    const account = address.slice(0, separator);
    const domain = address.slice(separator + 1);
    const node = [...this.nodes.values()].find(
      (candidate) => candidate.topology.domain === domain,
    );
    const user = node?.users.get(account);
    if (!user) throw new Error(`user actor is not loaded: ${address}`);
    return user;
  }

  get userCount() {
    return [...this.nodes.values()].reduce(
      (total, node) => total + node.users.size,
      0,
    );
  }
}
