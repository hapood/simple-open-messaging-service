import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitMessageOperation,
  submitMessage,
  parseContent,
} from './message-operations.mjs';

test('normalizes both JSONB database bodies and serialized API bodies without mutating snapshots', () => {
  const body = { text: 'hello', quote: { seq: 9 } };
  assert.deepEqual(parseContent(body), parseContent(JSON.stringify(body)));
  const parsed = parseContent(body);
  parsed.quote.seq = 42;
  assert.equal(body.quote.seq, 9);
});

test('retries one immutable request without creating a second logical send', async () => {
  for (const retryMode of ['CONCURRENT', 'AFTER_SUCCESS']) {
    const requests = [];
    const result = await admitMessageOperation(
      {
        type: 'SEND_QUOTE',
        id: 'op-1',
        groupThreadId: 31,
        retryMode,
        clientMessageId: 'fixed-key',
        target: { seq: 9, creatorAddress: 'alice@alpha.test', originSeq: 2 },
      },
      {
        async post(path, body) {
          requests.push({ path, body });
          return { id: '14', seq: 12, originSeq: 8 };
        },
      },
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(result.attempts.length, 2);
    assert.deepEqual(result.expected.quote, {
      actor: 'alice@alpha.test',
      seq: 9,
    });
  }
});

test('captures a complete quote author reference before its profile binding arrives', async () => {
  const result = await admitMessageOperation(
    {
      type: 'SEND_QUOTE',
      id: 'op-unresolved',
      groupThreadId: 31,
      target: {
        seq: 10,
        creatorAccount: 'carol',
        creatorDomain: null,
        creatorAddress: null,
        publisherNamespaceId: 1,
        profileNamespaceId: 2,
      },
    },
    {
      async post() {
        return { seq: 18 };
      },
    },
  );
  assert.deepEqual(result.expected.quote, {
    seq: 10,
    authorRef: {
      account: 'carol',
      publisherNamespaceId: 1,
      profileNamespaceId: 2,
    },
  });
});

test('rejects duplicate submissions returning different business identities', async () => {
  let id = 0;
  await assert.rejects(
    submitMessage(
      async () => ({ id: ++id, seq: id, originSeq: id }),
      'CONCURRENT',
    ),
    /different message identities/,
  );
});

test('permits a group confirmation between idempotent attempts without changing local identity', async () => {
  let calls = 0;
  const result = await submitMessage(
    async () => ({
      seq: 8,
      originSeq: ++calls === 1 ? 8 : 10,
      threadId: 7,
      clientMessageId: 'same-request',
    }),
    'AFTER_SUCCESS',
  );
  assert.equal(result.attempts.length, 2);
});

test('awaits both concurrent attempts and records a failed transport', async () => {
  let calls = 0;
  let completed = false;
  await assert.rejects(
    submitMessage(async () => {
      if (++calls === 1) throw new Error('transport');
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = true;
      return { id: 1, seq: 1, originSeq: 1 };
    }, 'CONCURRENT'),
    (error) => {
      assert.equal(completed, true);
      assert.equal(error.attempts.length, 2);
      return true;
    },
  );
});
