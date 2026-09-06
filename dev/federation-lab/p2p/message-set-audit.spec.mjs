import assert from 'node:assert/strict';
import test from 'node:test';
import { compareCurrentMemberMessages } from './message-set-audit.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const threadKey = `${alice}|${bob}`;
const message = (account, domain, seq, originSeq, text) => ({
  creatorAccount: account,
  creatorDomain: domain,
  seq,
  originSeq,
  contentType: 'PURE_TEXT',
  content: text,
  localState: 'READY',
  isDeleted: false,
});
function fixture() {
  return {
    groupAddress: threadKey,
    members: [alice, bob],
    nodeNames: ['alpha', 'bravo'],
    signature: (_node, row) => row.content,
    messages: {
      alpha: new Map([
        [
          threadKey,
          {
            curSeq: 7,
            deletedSeqs: new Set(),
            messages: [
              message('alice', 'local', 2, 2, 'before removing friend'),
              message('bob', 'bravo.test', 7, 4, 'after re-adding friend'),
            ],
          },
        ],
      ]),
      bravo: new Map([
        [
          threadKey,
          {
            curSeq: 4,
            deletedSeqs: new Set(),
            messages: [
              message('alice', 'alpha.test', 1, 2, 'before removing friend'),
              message('bob', 'local', 4, 4, 'after re-adding friend'),
            ],
          },
        ],
      ]),
    },
  };
}
test('compares all current authors across different local seq spaces, including retained history', () => {
  assert.deepEqual(compareCurrentMemberMessages(fixture()).failures, []);
});

test('validates a group submission, authority copy, and third-node mirror after confirmation', () => {
  const key = '!group@alpha.test';
  const carol = 'carol@charlie.test';
  const row = (seq, originSeq, domain, sourceDomain) => ({
    ...message('carol', domain, seq, originSeq, 'three coordinate spaces'),
    sourceDomain,
  });
  const thread = (entry) => ({
    curSeq: entry.seq,
    messages: [entry],
    deletedSeqs: new Set(),
  });
  const value = {
    groupAddress: key,
    members: [carol],
    nodeNames: ['alpha', 'bravo', 'charlie'],
    signature: (_node, entry) => entry.content,
    messages: {
      alpha: new Map([
        [key, thread(row(10, 8, 'charlie.test', 'charlie.test'))],
      ]),
      bravo: new Map([[key, thread(row(9, 10, 'charlie.test', 'alpha.test'))]]),
      charlie: new Map([[key, thread(row(8, 10, 'local', 'alpha.test'))]]),
    },
  };
  assert.deepEqual(compareCurrentMemberMessages(value).failures, []);
  const source = value.messages.charlie.get(key).messages[0];
  source.originSeq = 8;
  assert.ok(
    compareCurrentMemberMessages(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_ORIGIN_SEQ',
    ),
  );
  source.originSeq = 10;
  value.messages.bravo.get(key).messages[0].originSeq = 8;
  assert.ok(compareCurrentMemberMessages(value).failures.length > 0);
});
test('detects a historical message lost after friendship is re-established', () => {
  const value = fixture();
  value.messages.bravo.get(threadKey).messages.shift();
  assert.ok(
    compareCurrentMemberMessages(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_MESSAGE_MISSING',
    ),
  );
});

test('P2P permits absent withdrawn history only after scanning, never an undeleted retained copy', () => {
  const value = fixture();
  const source = value.messages.alpha.get(threadKey);
  const mirror = value.messages.bravo.get(threadKey);
  source.messages[0].isDeleted = true;
  source.deletedSeqs.add(2);
  const retained = mirror.messages.shift();
  mirror.syncState = {
    messageTargetSeq: 2,
    messageProcessedThroughSeq: 2,
    deletionTargetSeq: 1,
    deletionProcessedThroughSeq: 1,
    historyBoundaryReached: true,
    activeGapId: null,
  };
  mirror.historyGaps = [];
  assert.deepEqual(compareCurrentMemberMessages(value).failures, []);
  mirror.syncState.deletionRecoveryThroughSeq = 1;
  assert.ok(
    compareCurrentMemberMessages(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_MESSAGE_MISSING',
    ),
  );
  mirror.syncState.deletionRecoveryThroughSeq = null;
  mirror.messages.unshift(retained);
  assert.ok(
    compareCurrentMemberMessages(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_DELETION_MISMATCH',
    ),
  );
  retained.isDeleted = true;
  assert.ok(
    compareCurrentMemberMessages(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_TOMBSTONE_MISSING',
    ),
  );
  mirror.deletedSeqs.add(retained.seq);
  assert.deepEqual(compareCurrentMemberMessages(value).failures, []);
});
test('does not require message equality for historical group members', () => {
  const value = fixture();
  value.members = [bob];
  value.messages.bravo.get(threadKey).messages.shift();
  assert.deepEqual(compareCurrentMemberMessages(value).failures, []);
});
test('detects source coordinate drift, duplicate seq, and deleted-state mismatch', () => {
  const drift = fixture();
  drift.messages.bravo.get(threadKey).messages[1].originSeq = 3;
  assert.ok(
    compareCurrentMemberMessages(drift).failures.some(
      ({ kind }) => kind === 'AUTHOR_ORIGIN_SEQ',
    ),
  );
  const duplicate = fixture();
  duplicate.messages.alpha.get(threadKey).messages[1].seq = 2;
  assert.ok(
    compareCurrentMemberMessages(duplicate).failures.some(
      ({ kind }) => kind === 'MESSAGE_COORDINATE',
    ),
  );
  const deleted = fixture();
  deleted.messages.bravo.get(threadKey).messages[1].isDeleted = true;
  deleted.messages.bravo.get(threadKey).deletedSeqs.add(4);
  assert.ok(
    compareCurrentMemberMessages(deleted).failures.some(
      ({ kind }) => kind === 'AUTHOR_DELETION_MISMATCH',
    ),
  );
});
