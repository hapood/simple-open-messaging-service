import assert from 'node:assert/strict';
import test from 'node:test';
import { FederationLabActors } from './api-actors.mjs';

function response(data, headers = {}) {
  return new Response(
    JSON.stringify({ code: 0, message: 'successful', data }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...headers },
    },
  );
}

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
