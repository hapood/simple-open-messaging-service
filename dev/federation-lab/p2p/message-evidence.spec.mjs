import assert from 'node:assert/strict';
import test from 'node:test';
import { quoteIdentity } from './message-evidence.mjs';

test('quote namespace is independent of the parent origin and isolates identical sequence numbers', () => {
  const node = { name: 'alpha', domain: 'alpha.test' };
  const thread = {
    messages: [
      {
        seq: 4,
        originSeq: 8,
        sourceNamespaceId: 11,
        creatorAccount: 'wrong',
        creatorDomain: 'bravo.test',
      },
      {
        seq: 5,
        originSeq: 8,
        sourceNamespaceId: 12,
        creatorAccount: 'right',
        creatorDomain: 'charlie.test',
      },
    ],
  };
  const message = {
    sourceNamespaceId: 11,
    content: { quote: { seq: 8, namespaceId: 12 } },
  };
  assert.deepEqual(
    quoteIdentity(node, message, thread, {}, '!group@alpha.test'),
    { actor: 'right@charlie.test', seq: 8 },
  );
  message.content.quote.namespaceId = 0;
  message.content.quote.seq = 4;
  assert.deepEqual(
    quoteIdentity(node, message, thread, {}, '!group@alpha.test'),
    { actor: 'wrong@bravo.test', seq: 8 },
  );
});

test('resolves an absent target using the quote source instead of the containing message source', () => {
  const key = '!group@alpha.test';
  const node = { name: 'bravo', domain: 'bravo.test' };
  const message = {
    sourceDomain: 'charlie.test',
    quoteSourceDomain: 'alpha.test',
    sourceNamespaceId: 12,
    content: { quote: { seq: 42, namespaceId: 11 } },
  };
  const messages = {
    alpha: new Map([
      [
        key,
        {
          messages: [
            {
              seq: 42,
              originSeq: 8,
              creatorAccount: 'carol',
              creatorDomain: 'charlie.test',
            },
          ],
        },
      ],
    ]),
  };
  assert.deepEqual(
    quoteIdentity(node, message, { messages: [] }, messages, key),
    { actor: 'carol@charlie.test', seq: 8 },
  );
});

test('maps publisher seq 3 to foreign author origin seq 2 without a local target row', () => {
  const key = '!group@alpha.test';
  const source = {
    seq: 3,
    originSeq: 2,
    creatorAccount: 'carol',
    creatorDomain: 'charlie.test',
    isDeleted: true,
  };
  const messages = { alpha: new Map([[key, { messages: [source] }]]) };
  const quote = {
    sourceDomain: 'alpha.test',
    sourceNamespaceId: 12,
    content: { quote: { seq: 0, sourceSeq: 3 } },
  };
  const node = { name: 'bravo', domain: 'bravo.test' };
  assert.deepEqual(
    quoteIdentity(node, quote, { messages: [] }, messages, key),
    { actor: 'carol@charlie.test', seq: 2 },
  );
  quote.content.quote.sourceSeq = 2;
  assert.equal(
    quoteIdentity(node, quote, { messages: [] }, messages, key).unresolved,
    true,
  );
});
