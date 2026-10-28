import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FederationLabActors,
  LabAdminActor,
  LabUserActor,
} from './api-actors.mjs';

function response(data, headers = {}) {
  return new Response(
    JSON.stringify({ code: 0, message: 'successful', data }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

test('preserves an HTTP 200 profile denial in the reported error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        code: 10001,
        message: 'profile is not available',
        data: null,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'profile-denied',
        },
      },
    );
  try {
    const actor = new LabUserActor({
      node: { domain: 'bravo.test', backendBaseUrl: 'http://127.0.0.1:3202' },
      id: 5,
      account: 'p2p-b-005',
      token: 'private-test-token',
    });
    await assert.rejects(
      actor.resolveProfile({
        account: 'p2p-a-004',
        domain: 'alpha.test',
        rev: 3,
      }),
      (error) => {
        assert.match(
          error.message,
          /HTTP 200 code=10001 message=profile is not available requestId=profile-denied/,
        );
        assert.equal(error.details.requestId, 'profile-denied');
        assert.ok(!error.message.includes('private-test-token'));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveOwnProfile resolves the full local profile projection', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const profile = {
    id: 5,
    account: 'p2p-b-005',
    name: 'Snapshot DIRECT',
    avatar: '/api/v1/media/avatar/abc.webp',
    bio: '',
  };
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return response(profile);
  };
  try {
    const actor = new LabUserActor({
      node: { domain: 'bravo.test', backendBaseUrl: 'http://127.0.0.1:3202' },
      id: 5,
      account: 'p2p-b-005',
      token: 'private-test-token',
    });
    assert.deepEqual(await actor.resolveOwnProfile(), profile);
    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, 'http://127.0.0.1:3202/api/v1/user/resolve');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { account: 'p2p-b-005' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps three administrators and API-provisioned OTP users in memory', async () => {
  const responses = [
    response(
      { authenticated: true },
      { 'Set-Cookie': 'admin_session=alpha-cookie; Path=/; HttpOnly' },
    ),
    response(
      { authenticated: true },
      { 'Set-Cookie': 'admin_session=bravo-cookie; Path=/; HttpOnly' },
    ),
    response(
      { authenticated: true },
      { 'Set-Cookie': 'admin_session=charlie-cookie; Path=/; HttpOnly' },
    ),
    response({ id: 17, account: 'alpha0001' }),
    response({ code: '123456' }),
    response({ session_token: 'user-token' }),
    response({ id: 17, account: 'alpha0001', domain: 'local' }),
  ];
  const calls = [];
  const fetchMock = async (...args) => {
    calls.push(args);
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    const actors = await FederationLabActors.connect({
      adminPassword: 'bootstrap-password',
    });
    const user = await actors.createAndLoginUser('alpha', {
      account: 'alpha0001',
      name: 'Alpha 0001',
    });

    assert.equal(actors.nodes.size, 3);
    assert.equal(actors.userCount, 1);
    assert.equal(actors.user('alpha0001@alpha.test'), user);
    assert.deepEqual(await user.myProfile(), {
      id: 17,
      account: 'alpha0001',
      domain: 'local',
    });

    assert.deepEqual(
      calls.map(([url]) => url),
      [
        'http://127.0.0.1:3201/api/v1/admin/login',
        'http://127.0.0.1:3202/api/v1/admin/login',
        'http://127.0.0.1:3203/api/v1/admin/login',
        'http://127.0.0.1:3201/api/v1/admin/users/create',
        'http://127.0.0.1:3201/api/v1/admin/users/17/issue-login-code',
        'http://127.0.0.1:3201/api/v1/auth/otp/login',
        'http://127.0.0.1:3201/api/v1/user/my-profile',
      ],
    );
    assert.equal(
      calls[3][1].headers.get('Cookie'),
      'admin_session=alpha-cookie',
    );
    assert.equal(calls[6][1].headers.get('Authorization'), 'Bearer user-token');
    assert.equal(responses.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('renews an expired administrator session once and replays the request', async () => {
  const calls = [];
  const responses = [
    response(
      { authenticated: true },
      { 'Set-Cookie': 'admin_session=initial; Path=/; HttpOnly' },
    ),
    new Response(
      JSON.stringify({ code: 401, message: 'Unauthorized', data: null }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ),
    response(
      { authenticated: true },
      { 'Set-Cookie': 'admin_session=renewed; Path=/; HttpOnly' },
    ),
    response({ total: 0, list: [] }),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch call');
    return next;
  };
  try {
    const admin = await LabAdminActor.login({
      node: {
        domain: 'alpha.test',
        backendBaseUrl: 'http://127.0.0.1:3201',
      },
      password: 'bootstrap-password',
    });

    assert.deepEqual(await admin.durableTasks({ status: 'PENDING' }), {
      total: 0,
      list: [],
    });
    assert.deepEqual(
      calls.map(([url]) => url),
      [
        'http://127.0.0.1:3201/api/v1/admin/login',
        'http://127.0.0.1:3201/api/v1/admin/durable-tasks',
        'http://127.0.0.1:3201/api/v1/admin/login',
        'http://127.0.0.1:3201/api/v1/admin/durable-tasks',
      ],
    );
    assert.equal(calls[1][1].headers.get('Cookie'), 'admin_session=initial');
    assert.equal(calls[3][1].headers.get('Cookie'), 'admin_session=renewed');
    assert.equal(responses.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('coalesces concurrent administrator session renewal', async () => {
  const calls = [];
  let loginCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    const [url, options] = args;
    if (url.endsWith('/admin/login')) {
      loginCount += 1;
      if (loginCount === 2)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return response(
        { authenticated: true },
        {
          'Set-Cookie': `admin_session=${loginCount === 1 ? 'initial' : 'renewed'}; Path=/; HttpOnly`,
        },
      );
    }
    if (options.headers.get('Cookie') === 'admin_session=initial') {
      return new Response(
        JSON.stringify({ code: 401, message: 'Unauthorized', data: null }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return response({ total: 0, list: [] });
  };
  try {
    const admin = await LabAdminActor.login({
      node: {
        domain: 'alpha.test',
        backendBaseUrl: 'http://127.0.0.1:3201',
      },
      password: 'bootstrap-password',
    });

    const activity = await admin.durableTaskActivity();
    assert.equal(activity.pendingCount, 0);
    assert.equal(activity.failedCount, 0);
    assert.deepEqual(activity.failed, []);
    for (const status of ['PENDING', 'PROCESSING', 'FAILED']) {
      assert.ok(Number.isInteger(activity.queryMs[status]));
      assert.ok(activity.queryMs[status] >= 0);
    }

    assert.equal(loginCount, 2);
    assert.equal(
      calls.filter(([url]) => url.endsWith('/admin/durable-tasks')).length,
      6,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stages and uploads every gallery part with stable identities', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    if (calls.length === 8)
      return new Response(
        JSON.stringify({
          code: 30006,
          message: 'initialize cursor',
          data: { resumeAfter: 0, resumeBefore: 8 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    if (calls.length === 9)
      return response({
        messages: [
          {
            seq: 7,
            originSeq: 7,
            clientMessageId: '11111111-1111-4111-8111-111111111111',
          },
        ],
        gaps: [],
        scannedThrough: 1,
        hasMore: false,
      });
    if (String(args[0]).endsWith('/uploads/resumable/init')) {
      return response({
        uploadId: `upload-${calls.length}`,
        chunkSize: 4,
        offset: 0,
      });
    }
    return response({ digest: `digest-${calls.length}` });
  };
  try {
    const actor = new LabUserActor({
      node: {
        name: 'alpha',
        domain: 'alpha.test',
        backendBaseUrl: 'http://127.0.0.1:3201',
      },
      id: 1,
      account: 'alice',
      token: 'token',
    });
    const message = await actor.sendMedia({
      threadId: 7,
      clientMessageId: '11111111-1111-4111-8111-111111111111',
      parts: [
        {
          partId: '22222222-2222-4222-8222-222222222222',
          filename: 'one.txt',
          bytes: Buffer.from('one'),
        },
        {
          partId: '33333333-3333-4333-8333-333333333333',
          filename: 'two.txt',
          bytes: Buffer.from('two'),
        },
      ],
    });
    assert.equal(message.originSeq, 7);
    assert.equal(calls.length, 9);
    assert.match(calls[0][0], /send-media$/);
    assert.equal(JSON.parse(calls[0][1].body).contentType, 'GALLERY');
    for (const index of [1, 4]) {
      assert.match(calls[index][0], /uploads\/resumable\/init$/);
      const init = JSON.parse(calls[index][1].body);
      assert.equal(
        init.clientMessageId,
        '11111111-1111-4111-8111-111111111111',
      );
      assert.equal(init.totalBytes, 3);
      assert.equal(init.position, index === 1 ? 0 : 1);
      assert.equal(calls[index + 1][1].method, 'PUT');
      assert.equal(calls[index + 1][1].headers['content-range'], 'bytes 0-2/3');
      assert.match(calls[index + 2][0], /\/complete$/);
    }
    assert.match(calls[7][0], /query-messages$/);
    assert.deepEqual(JSON.parse(calls[8][1].body), {
      threadId: 7,
      before: 8,
      take: 50,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
