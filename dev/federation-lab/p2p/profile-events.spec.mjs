import assert from 'node:assert/strict';
import test from 'node:test';
import { openProfileEvents } from './profile-events.mjs';
import { resolveUntilReady } from './profile-resolution.mjs';

const actor = {
  address: 'viewer@bravo.test',
  token: 'test-token',
  node: { backendBaseUrl: 'http://bravo.test' },
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

test('buffers early terminal events, parses split CRLF frames and matches request IDs', async () => {
  const s = await stream();
  try {
    s.send(
      ': connected\r\n\r\nevent: PROFILE_FAILED\r\ndata: {"requestId":"other","reason":"NOT_FOUND"}\r\n\r\nevent: PROFILE_RESOLVED\r\ndata: {"requestId":"wanted","profile":{"rev":7}}\r',
    );
    s.send('\n\r\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await s.events.wait('wanted'), {
      event: 'PROFILE_RESOLVED',
      requestId: 'wanted',
      profile: { rev: 7 },
    });
    assert.equal((await s.events.wait('other')).reason, 'NOT_FOUND');
  } finally {
    await s.events.close();
  }
  assert.equal(s.cancelled, true);
});

test('reports PROFILE_FAILED immediately instead of repeatedly creating PENDING requests', async () => {
  const s = await stream();
  let calls = 0;
  try {
    const user = {
      ...actor,
      resolveProfile: async () => {
        calls++;
        s.send(
          'event: PROFILE_FAILED\ndata: {"requestId":"failed","reason":"NOT_FOUND"}\n\n',
        );
        return { status: 'PENDING', requestId: 'failed' };
      },
    };
    await assert.rejects(
      resolveUntilReady(
        user,
        { threadId: 19, messageSeq: 5 },
        1,
        1000,
        s.events,
      ),
      /threadId.*19.*messageSeq.*5.*requestId=failed reason=NOT_FOUND/,
    );
    assert.equal(calls, 1);
  } finally {
    await s.events.close();
  }
});

test('accepts ready profiles and verifies the exact revision after SSE resolution', async () => {
  const s = await stream();
  try {
    const ready = {
      ...actor,
      resolveProfile: async () => ({ status: 'READY', profile: { rev: 7 } }),
    };
    assert.deepEqual(await resolveUntilReady(ready, {}, 7, 1000, s.events), {
      rev: 7,
    });
    const pending = {
      ...actor,
      resolveProfile: async () => {
        s.send(
          'event: PROFILE_RESOLVED\ndata: {"requestId":"resolved","profile":{"rev":8}}\n\n',
        );
        return { status: 'PENDING', requestId: 'resolved' };
      },
    };
    await assert.rejects(
      resolveUntilReady(pending, {}, 7, 1000, s.events),
      /returned rev 8, expected 7/,
    );
  } finally {
    await s.events.close();
  }
});

test('rejects pending waiters on disconnect and bounds missing-event waits', async () => {
  const s = await stream();
  try {
    await assert.rejects(s.events.wait('missing', 5), /requestId=missing/);
    const pending = s.events.wait('disconnected');
    s.end();
    await assert.rejects(pending, /SSE disconnected/);
    await assert.rejects(s.events.wait('later'), /SSE disconnected/);
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
    const pending = s.events.wait('invalid');
    s.send('event: PROFILE_FAILED\ndata: {}\n\n');
    await assert.rejects(pending, /no requestId/);
  } finally {
    await s.events.close();
  }
});
