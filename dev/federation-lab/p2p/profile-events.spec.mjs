import assert from 'node:assert/strict';
import test from 'node:test';
import { openProfileEvents } from './profile-events.mjs';
import { resolveUntilReady } from './profile-resolution.mjs';

const actor = {
  address: 'viewer@bravo.test',
  token: 'test-token',
  node: { backendBaseUrl: 'http://bravo.test' },
};
const key = {
  publisherNamespaceId: 2,
  profileNamespaceId: 0,
  account: 'alice',
  rev: 7,
};

async function stream() {
  let controller;
  let cancelled = false;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  const events = await openProfileEvents(actor, 1000, async (url, options) => {
    assert.equal(url, 'http://bravo.test/api/v1/events');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return {
    events,
    send(text) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    end() {
      controller.close();
    },
    get cancelled() {
      return cancelled;
    },
  };
}

test('buffers early profile wakes and parses split CRLF frames', async () => {
  const s = await stream();
  try {
    s.send(
      `: connected\r\n\r\nevent: PROFILE_AVAILABLE\r\ndata: ${JSON.stringify(key)}\r`,
    );
    s.send('\n\r\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await s.events.wait(), {
      event: 'PROFILE_AVAILABLE',
      key,
      reason: undefined,
    });
  } finally {
    await s.events.close();
  }
  assert.equal(s.cancelled, true);
});

test('reports PROFILE_UNAVAILABLE without creating another request', async () => {
  const s = await stream();
  let calls = 0;
  try {
    const user = {
      ...actor,
      resolveProfile: async () => {
        calls++;
        s.send(
          `event: PROFILE_UNAVAILABLE\ndata: ${JSON.stringify({ ...key, reason: 'NOT_FOUND' })}\n\n`,
        );
        return { status: 'PENDING', key };
      },
    };
    await assert.rejects(
      resolveUntilReady(
        user,
        {
          publisherNamespaceId: 2,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 0, account: 'alice', rev: 7 },
        },
        7,
        1000,
        s.events,
      ),
      /publisherNamespaceId.*2.*alice.*NOT_FOUND/,
    );
    assert.equal(calls, 1);
  } finally {
    await s.events.close();
  }
});

test('rereads the durable result after PROFILE_AVAILABLE', async () => {
  const s = await stream();
  let calls = 0;
  try {
    const pending = {
      ...actor,
      resolveProfile: async () => {
        calls++;
        if (calls === 1) {
          s.send(`event: PROFILE_AVAILABLE\ndata: ${JSON.stringify(key)}\n\n`);
          return { status: 'PENDING', key };
        }
        return { status: 'READY', profile: { rev: 7 } };
      },
    };
    assert.deepEqual(await resolveUntilReady(pending, {}, 7, 1000, s.events), {
      rev: 7,
    });
    assert.equal(calls, 2);

    const wrong = {
      ...actor,
      resolveProfile: async () => ({ status: 'READY', profile: { rev: 8 } }),
    };
    await assert.rejects(
      resolveUntilReady(wrong, {}, 7, 1000, s.events),
      /returned rev 8, expected 7/,
    );
  } finally {
    await s.events.close();
  }
});

test('rejects waiters on timeout and disconnect', async () => {
  const s = await stream();
  try {
    await assert.rejects(s.events.wait(5), /timed out waiting for profile SSE/);
    const pending = s.events.wait();
    s.end();
    await assert.rejects(pending, /SSE disconnected/);
    await assert.rejects(s.events.wait(), /SSE disconnected/);
  } finally {
    await s.events.close();
  }
});

test('rejects non-SSE responses and invalid profile event data', async () => {
  await assert.rejects(
    openProfileEvents(actor, 1000, async () => new Response('{}')),
    /without an event stream/,
  );
  const s = await stream();
  try {
    const pending = s.events.wait();
    s.send('event: PROFILE_AVAILABLE\ndata: {}\n\n');
    await assert.rejects(pending, /no profile key/);
  } finally {
    await s.events.close();
  }
});
