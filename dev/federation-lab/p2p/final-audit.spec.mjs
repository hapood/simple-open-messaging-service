import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareFederationSnapshot,
  readNodeMessageAudit,
} from './final-audit.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const groupAddress = '!group@alpha.test';

function nodeP2p() {
  return {
    pairs: { all: [], active: [], duplicates: [], invalid: [] },
    intents: { directions: [], duplicates: [], invalid: [] },
  };
}

function groupProjection() {
  return {
    address: groupAddress,
    defaultProfileRev: 1,
    roster: [
      { address: alice, account: 'alice', role: 'OWNER', profileRev: 1 },
      { address: bob, account: 'bob', role: 'MEMBER', profileRev: 1 },
    ],
    relationships: new Map([
      [
        alice,
        { active: true, groupIntent: 'ACCEPTED', userIntent: 'ACCEPTED' },
      ],
      [bob, { active: true, groupIntent: 'ACCEPTED', userIntent: 'ACCEPTED' }],
    ]),
    messages: [
      {
        seq: 1,
        profileRev: 1,
        creatorAddress: alice,
        isDeleted: false,
        localState: 'READY',
      },
    ],
  };
}

function profile(address, profileRev = 1) {
  return {
    address,
    profileRev,
    displayName: address,
    bio: '',
    avatarDigest: null,
  };
}

function nodeProfiles(entries = []) {
  return {
    versions: new Map(
      entries.map((value) => [`${value.address}#${value.profileRev}`, value]),
    ),
    intentRefs: [],
  };
}

function messageThread(originSeq = 1, clientMessageId = null) {
  return {
    curSeq: 1,
    clearedSeq: null,
    messages: [
      {
        id: '1',
        seq: 1,
        originSeq,
        clientMessageId,
        isDeleted: false,
        localState: 'READY',
        creatorAccount: 'alice',
        creatorDomain: 'alpha.test',
      },
    ],
    deletedSeqs: new Set(),
    assets: [],
  };
}

function fixture() {
  return {
    log: {
      users: [alice, bob],
      groups: [{ address: groupAddress }],
      operations: [
        {
          id: 'op-1',
          type: 'SEND_GROUP_MESSAGE',
          group: groupAddress,
          actor: alice,
          status: 'SUCCEEDED',
          request: {
            body: {
              clientMessageId: '11111111-1111-4111-8111-111111111111',
            },
          },
          result: { originSeq: 1 },
        },
      ],
    },
    p2p: { alpha: nodeP2p(), bravo: nodeP2p(), charlie: nodeP2p() },
    groups: {
      alpha: { groups: new Map([[groupAddress, groupProjection()]]) },
      bravo: { groups: new Map([[groupAddress, groupProjection()]]) },
      charlie: { groups: new Map() },
    },
    messages: {
      alpha: new Map([[groupAddress, messageThread()]]),
      bravo: new Map([[groupAddress, messageThread()]]),
      charlie: new Map(),
    },
    profiles: {
      alpha: nodeProfiles([
        profile(alice),
        profile(bob),
        profile(groupAddress),
      ]),
      bravo: nodeProfiles([
        profile(alice),
        profile(bob),
        profile(groupAddress),
      ]),
      charlie: nodeProfiles(),
    },
  };
}

test('accepts matching final rosters, intents, message coordinates, and bodies', () => {
  const result = compareFederationSnapshot(fixture());
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('matches federated messages without copying the sender clientMessageId', () => {
  const value = fixture();
  value.messages.alpha.set(
    groupAddress,
    messageThread(1, '11111111-1111-4111-8111-111111111111'),
  );
  value.messages.bravo.set(groupAddress, messageThread(1, null));

  const result = compareFederationSnapshot(value);

  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('reads the local message id used to associate media bindings', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM "Group" grp'))
        return {
          rows: [
            {
              account: '!group',
              domain: 'local',
              threadId: 1,
              curSeq: 1,
              clearedSeq: null,
            },
          ],
        };
      if (sql.includes('FROM "Message" msg'))
        return {
          rows: [
            {
              id: '27',
              account: '!group',
              domain: 'local',
              threadId: 1,
            },
          ],
        };
      return { rows: [] };
    },
  };

  const result = await readNodeMessageAudit(client, {
    name: 'alpha',
    domain: 'alpha.test',
  });

  assert.match(queries[1], /msg\."id"::text AS "id"/);
  assert.equal(result.get('!group@alpha.test').messages[0].id, '27');
});

test('keeps sampling while a final member mirror lacks originSeq', () => {
  const value = fixture();
  value.messages.bravo.set(groupAddress, messageThread(null));
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(({ kind }) => kind === 'MESSAGE_COORDINATE'),
    true,
  );
});

test('also rejects a null originSeq on the authoritative original', () => {
  const value = fixture();
  value.messages.alpha.set(groupAddress, messageThread(null));
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(
      ({ kind, node }) => kind === 'MESSAGE_COORDINATE' && node === 'alpha',
    ),
    true,
  );
});

test('rejects a stale mirrored roster', () => {
  const value = fixture();
  value.groups.bravo.groups.get(groupAddress).roster.pop();
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(({ kind }) => kind === 'ROSTER'),
    true,
  );
});

test('rejects a referenced profile revision missing from a member node', () => {
  const value = fixture();
  value.profiles.bravo.versions.delete(`${alice}#1`);
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(
      ({ kind, node }) => kind === 'PROFILE_MISSING' && node === 'bravo',
    ),
    true,
  );
});

test('rejects a per-user message count attributed to the wrong sender', () => {
  const value = fixture();
  const [message] = value.messages.bravo.get(groupAddress).messages;
  message.creatorAccount = 'bob';
  message.creatorDomain = 'local';
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.some(({ kind }) => kind === 'USER_MESSAGE_COUNT'),
    true,
  );
  assert.equal(
    result.failures.some(({ kind }) => kind === 'MESSAGE_UNEXPECTED'),
    true,
  );
});
