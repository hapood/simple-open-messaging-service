import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareFederationSnapshot,
  readNodeMessageAudit,
  readAssetBytes,
} from './final-audit.mjs';

const alice = 'alice@alpha.test';
const bob = 'bob@bravo.test';
const groupAddress = '!group@alpha.test';

test('hashes physical bytes and reports unreadable files separately', async () => {
  assert.deepEqual(await readAssetBytes('/dev/null'), {
    diskDigest:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    diskBytes: 0,
  });
  const missing = await readAssetBytes('/dev/null/not-a-file');
  assert.equal(missing.diskDigest, null);
  assert.ok(missing.diskError);
});

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
          result: { seq: 1, originSeq: 1 },
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

test('business convergence permits lazy profiles but still rejects stale membership', () => {
  const value = fixture();
  value.profiles.bravo.versions.clear();
  assert.equal(compareFederationSnapshot(value).passed, false);
  value.validateProfiles = false;
  assert.equal(compareFederationSnapshot(value).passed, true);
  value.groups.bravo.groups.get(groupAddress).roster = [];
  assert.equal(compareFederationSnapshot(value).passed, false);
});

function galleryFixture() {
  const value = fixture();
  for (const [node, threadId, seq] of [
    ['alpha', 3, 1],
    ['bravo', 7, 9],
  ]) {
    const thread = value.messages[node].get(groupAddress);
    thread.curSeq = seq;
    Object.assign(thread.messages[0], {
      threadId,
      seq,
      contentType: 'GALLERY',
      content: {
        items: ['a', 'b'].map((hex) => ({
          url: `/uploads/msg-assets/${hex.repeat(2)}/${hex.repeat(2)}/${hex.repeat(64)}?threadId=${threadId}&seq=${seq}`,
          kind: 'FILE',
          name: `${hex}.png`,
          size: 146,
          mimeType: 'image/png',
        })),
      },
    });
  }
  return value;
}

test('compares gallery CAS identities across different local message coordinates without mutating snapshots', () => {
  const value = galleryFixture();
  const before = structuredClone(value.messages);
  const result = compareFederationSnapshot(value);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(value.messages, before);
});

for (const contentType of ['FILE', 'IMAGE', 'VIDEO', 'AUDIO']) {
  test(`oracle compares ${contentType} across local coordinates but rejects incorrect carrier URLs`, () => {
    const value = galleryFixture();
    for (const node of ['alpha', 'bravo']) {
      const row = value.messages[node].get(groupAddress).messages[0];
      row.contentType = contentType;
      row.content = { ...row.content.items[0] };
      delete row.content.kind;
    }
    const before = structuredClone(value.messages);
    assert.deepEqual(compareFederationSnapshot(value).failures, []);
    assert.deepEqual(value.messages, before);
    const mirror = value.messages.bravo.get(groupAddress).messages[0];
    mirror.content.url =
      value.messages.alpha.get(groupAddress).messages[0].content.url;
    assert.ok(
      compareFederationSnapshot(value).failures.some(
        ({ kind }) => kind === 'MESSAGE_MEDIA_URL',
      ),
    );
  });
}

test('rejects identical gallery URLs when they authorize the wrong local message', () => {
  const value = galleryFixture();
  for (const thread of [
    value.messages.alpha.get(groupAddress),
    value.messages.bravo.get(groupAddress),
  ])
    for (const item of thread.messages[0].content.items)
      item.url = item.url.replace(/\?.*$/, '?threadId=99&seq=99');
  const result = compareFederationSnapshot(value);
  assert.equal(result.passed, false);
  assert.equal(
    result.failures.filter(({ kind }) => kind === 'MESSAGE_MEDIA_URL').length,
    4,
  );
});

for (const field of ['digest', 'name', 'size', 'mimeType', 'order'])
  test(`still rejects gallery ${field} divergence`, () => {
    const value = galleryFixture();
    const items =
      value.messages.bravo.get(groupAddress).messages[0].content.items;
    if (field === 'digest')
      items[0].url = items[0].url.replace(
        `/aa/aa/${'a'.repeat(64)}`,
        `/cc/cc/${'c'.repeat(64)}`,
      );
    else if (field === 'order') items.reverse();
    else items[0][field] = field === 'size' ? 999 : 'changed';
    const result = compareFederationSnapshot(value);
    assert.ok(
      result.failures.some(({ kind }) => kind === 'AUTHOR_MESSAGE_CONTENT'),
    );
    assert.ok(result.failures.some(({ kind }) => kind === 'MESSAGE_CONTENT'));
  });

test('compares three-node group messages and quotes after the author origin coordinate is confirmed', () => {
  const value = fixture();
  const carol = 'carol@charlie.test';
  value.validateProfiles = false;
  value.log.users.push(carol);
  value.groups.charlie = {
    groups: new Map([[groupAddress, groupProjection()]]),
  };
  value.messages.charlie.set(groupAddress, messageThread());
  for (const [node, seq, originSeq, domain, sourceDomain] of [
    ['alpha', 10, 8, 'bravo.test', 'bravo.test'],
    ['bravo', 8, 10, 'local', 'alpha.test'],
    ['charlie', 9, 10, 'bravo.test', 'alpha.test'],
  ]) {
    const projection = value.groups[node].groups.get(groupAddress);
    projection.roster.push({ address: carol, role: 'MEMBER', profileRev: 1 });
    projection.relationships.set(carol, {
      active: true,
      groupIntent: 'ACCEPTED',
      userIntent: 'ACCEPTED',
    });
    const thread = value.messages[node].get(groupAddress);
    thread.curSeq = seq;
    thread.messages[0].content = { text: 'reply', quote: { seq } };
    thread.messages[0].contentType = 'PURE_TEXT';
    thread.messages.push({
      id: '2',
      seq,
      originSeq,
      creatorAccount: 'bob',
      creatorDomain: domain,
      sourceDomain,
      contentType: 'PURE_TEXT',
      content: { text: 'source' },
      isDeleted: false,
      localState: 'READY',
      profileRev: 1,
    });
  }
  value.log.operations[0].expected = { quote: { actor: bob, seq: 10 } };
  value.log.operations.push({
    id: 'op-2',
    type: 'SEND_GROUP_MESSAGE',
    group: groupAddress,
    actor: bob,
    status: 'SUCCEEDED',
    request: { body: { clientMessageId: 'bob-request' } },
    // A retry may already return the confirmed coordinate; local seq remains the journal identity.
    result: { seq: 8, originSeq: 10 },
    expected: { text: 'source' },
  });
  const result = compareFederationSnapshot(value);
  assert.deepEqual(result.failures, []);
  value.messages.bravo.get(groupAddress).messages[1].originSeq = 8;
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'AUTHOR_ORIGIN_SEQ',
    ),
  );
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
      if (sql.includes('FROM "MessageThread" thread'))
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

for (const authorityNamespaceId of [0, 1])
  test(`keeps all source states without substituting another peer for authority ${authorityNamespaceId}`, async () => {
    const sourceStates = [
      { threadId: 1, namespaceId: 1, messageProcessedThroughSeq: 10 },
      { threadId: 1, namespaceId: 2, messageProcessedThroughSeq: 99 },
    ];
    const client = {
      async query(sql) {
        if (sql.includes('FROM "MessageThread" thread'))
          return {
            rows: [
              {
                account: '!group',
                domain: 'alpha.test',
                threadId: 1,
                curSeq: 10,
                authorityNamespaceId,
              },
            ],
          };
        if (sql.includes('FROM "FederationThreadSyncState"'))
          return { rows: sourceStates };
        return { rows: [] };
      },
    };
    const threads = await readNodeMessageAudit(client, {
      name: 'bravo',
      domain: 'bravo.test',
    });
    const thread = threads.get(groupAddress);
    assert.deepEqual(thread.syncStates, sourceStates);
    assert.deepEqual(
      thread.syncState,
      authorityNamespaceId === 1 ? sourceStates[0] : null,
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

test('rejects identical corrupt content on every node using the submitted text', () => {
  const value = fixture();
  value.log.operations[0].expected = { text: 'submitted text' };
  for (const node of ['alpha', 'bravo'])
    value.messages[node].get(groupAddress).messages[0].content =
      '{"text":"corrupt"}';
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'MESSAGE_SUBMITTED_CONTENT',
    ),
  );
});

test('rejects identical missing avatar paths on source and mirror', () => {
  const value = fixture();
  for (const node of ['alpha', 'bravo'])
    value.profiles[node].versions.get(`${alice}#1`).avatarDigest =
      'missing:/uploads/avatar.png';
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'PROFILE_AVATAR_UNREADABLE',
    ),
  );
});

test('rejects a stale current group profile reference even when both immutable versions exist', () => {
  const value = fixture();
  value.groups.alpha.groups.get(groupAddress).defaultProfileRev = 2;
  value.profiles.alpha.versions.set(
    `${groupAddress}#2`,
    profile(groupAddress, 2),
  );
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'GROUP_PROFILE_REFERENCE',
    ),
  );
});

test('requires origin dissolution and revoked memberships while retaining historical mirror metadata', () => {
  const value = fixture();
  value.log.operations.push({
    type: 'DISSOLVE_GROUP',
    group: groupAddress,
    status: 'SUCCEEDED',
    audienceNodes: ['alpha', 'bravo'],
    membersBeforeDissolution: [alice, bob],
  });
  for (const node of ['alpha', 'bravo']) {
    const group = value.groups[node].groups.get(groupAddress);
    group.dissolved = node === 'alpha';
    for (const relation of group.relationships.values())
      relation.active = false;
  }
  assert.equal(compareFederationSnapshot(value).passed, true);
  value.groups.bravo.groups.get(groupAddress).relationships.get(bob).active =
    true;
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'DISSOLVED_MEMBERSHIP',
    ),
  );
  value.groups.bravo.groups.get(groupAddress).relationships.get(bob).active =
    false;
  value.messages.bravo.get(groupAddress).messages = [];
  assert.equal(compareFederationSnapshot(value).passed, true);

  // The resolver skips dissolved groups. Their historical references need not
  // have been fetched, but corrupt snapshots must not escape validation.
  const cached = value.profiles.bravo.versions.get(`${groupAddress}#1`);
  value.profiles.bravo.versions.delete(`${groupAddress}#1`);
  assert.equal(compareFederationSnapshot(value).passed, true);
  value.profiles.bravo.versions.set(`${groupAddress}#1`, {
    ...cached,
    displayName: 'corrupt cached history',
  });
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'PROFILE_CONTENT',
    ),
  );
  value.profiles.bravo.versions.set(`${groupAddress}#1`, cached);
  value.groups.alpha.groups.get(groupAddress).dissolved = false;
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind }) => kind === 'ROSTER_INVARIANT',
    ),
  );
});

test('still requires lazy group profiles for currently authorized mirrors', () => {
  const value = fixture();
  value.profiles.bravo.versions.delete(`${groupAddress}#1`);
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind, source }) =>
        kind === 'PROFILE_MISSING' && source === 'GROUP_META_PROFILE',
    ),
  );
});

test('matches quote targets by origin identity, not by node-local seq', () => {
  const value = fixture();
  for (const [node, seq] of [
    ['alpha', 2],
    ['bravo', 9],
  ]) {
    const thread = value.messages[node].get(groupAddress);
    thread.curSeq = seq;
    thread.clearedSeq = seq - 1;
    thread.messages[0].content = JSON.stringify({
      text: 'reply',
      quote: { seq },
    });
    thread.messages.push({
      ...thread.messages[0],
      id: '2',
      seq,
      originSeq: 2,
      content: '{"text":"source"}',
      contentType: 'SYSTEM',
    });
  }
  assert.equal(compareFederationSnapshot(value).passed, true);
});

function lateWithdrawalFixture() {
  const value = fixture();
  const authority = value.messages.alpha.get(groupAddress);
  const mirror = value.messages.bravo.get(groupAddress);
  authority.curSeq = mirror.curSeq = 2;
  authority.messages[0].content = { text: 'reply', quote: { seq: 2 } };
  mirror.messages[0].content = {
    text: 'reply',
    quote: { seq: 0, sourceSeq: 2 },
  };
  mirror.messages[0].sourceDomain = 'alpha.test';
  mirror.messages[0].sourceNamespaceId = 5;
  authority.messages.push({
    ...authority.messages[0],
    seq: 2,
    originSeq: 2,
    content: { text: 'withdrawn' },
    isDeleted: true,
  });
  authority.deletedSeqs.add(2);
  mirror.syncState = {
    messageTargetSeq: 2,
    messageProcessedThroughSeq: 2,
    deletionTargetSeq: 1,
    deletionProcessedThroughSeq: 1,
    historyBoundaryReached: true,
    activeGapId: null,
  };
  mirror.historyGaps = [];
  value.log.operations[0].expected = { quote: { actor: alice, originSeq: 2 } };
  value.log.operations.push(
    {
      id: 'source',
      type: 'SEND_GROUP_MESSAGE',
      actor: alice,
      group: groupAddress,
      status: 'SUCCEEDED',
      scenario: 'REFERENCE_WITHDRAWAL',
      request: { body: { clientMessageId: 'source' } },
      result: { seq: 2, originSeq: 2 },
    },
    {
      id: 'withdraw',
      type: 'WITHDRAW_GROUP_MESSAGE',
      status: 'SUCCEEDED',
      withdrawnClientMessageId: 'source',
    },
  );
  return value;
}

test('accepts a scanned late mirror without withdrawn body and resolves its source quote', () => {
  assert.deepEqual(
    compareFederationSnapshot(lateWithdrawalFixture()).failures,
    [],
  );
});

test('does not accept wrong source coordinates, unscanned history, or missing live bodies', () => {
  for (const mutate of [
    (v) => {
      v.messages.bravo.get(groupAddress).messages[0].content.quote.sourceSeq =
        99;
    },
    (v) => {
      v.messages.bravo.get(groupAddress).messages[0].sourceDomain =
        'charlie.test';
    },
    (v) => {
      v.messages.bravo.get(groupAddress).historyGaps = [
        { startSeq: 1, endSeq: 2 },
      ];
    },
    (v) => {
      v.messages.bravo.get(groupAddress).syncState.historyBoundaryReached =
        false;
    },
    (v) => {
      v.messages.bravo.get(groupAddress).messages = [];
    },
    (v) => {
      v.messages.alpha.get(groupAddress).messages[1].isDeleted = false;
    },
    (v) => {
      const t = v.messages.bravo.get(groupAddress);
      t.messages.push({
        ...v.messages.alpha.get(groupAddress).messages[1],
        isDeleted: false,
      });
    },
  ]) {
    const value = lateWithdrawalFixture();
    mutate(value);
    assert.equal(compareFederationSnapshot(value).passed, false);
  }
});

test('excludes historical authors even when the authority retains messages absent from a former member peer', () => {
  const value = fixture();
  for (const node of ['alpha', 'bravo']) {
    const group = value.groups[node].groups.get(groupAddress);
    group.roster = group.roster.filter(({ address }) => address !== bob);
    group.relationships.get(bob).active = false;
  }
  value.messages.alpha.get(groupAddress).messages.push({
    ...messageThread().messages[0],
    id: 'old',
    seq: 2,
    originSeq: 88,
    creatorAccount: 'bob',
    creatorDomain: 'bravo.test',
  });
  value.messages.alpha.get(groupAddress).curSeq = 2;
  value.messages.bravo = new Map();
  assert.equal(compareFederationSnapshot(value).passed, true);
});

test('audits retained P2P messages after re-adding a friend, but skips inactive friendships', () => {
  const value = fixture();
  const pair = `${alice}|${bob}`;
  value.p2pMessages = {
    alpha: new Map([[pair, messageThread()]]),
    bravo: new Map([[pair, messageThread()]]),
    charlie: new Map(),
  };
  value.log.operations.push(
    {
      type: 'REVOKE_RELATIONSHIP',
      status: 'SUCCEEDED',
      actor: alice,
      peer: bob,
    },
    { type: 'ACCEPT_REQUEST', status: 'SUCCEEDED', actor: bob, peer: alice },
  );
  for (const node of ['alpha', 'bravo']) value.p2p[node].pairs.active = [pair];
  assert.equal(compareFederationSnapshot(value).passed, true);
  value.p2pMessages.bravo.get(pair).messages = [];
  assert.ok(
    compareFederationSnapshot(value).failures.some(
      ({ kind, threadType }) =>
        kind === 'AUTHOR_MESSAGE_MISSING' && threadType === 'P2P',
    ),
  );
  for (const node of ['alpha', 'bravo']) value.p2p[node].pairs.active = [];
  assert.equal(compareFederationSnapshot(value).passed, true);
});

function p2pWithdrawalFixture() {
  const value = fixture();
  const pair = `${alice}|${bob}`;
  const authority = messageThread(1, 'p2p-message');
  authority.messages[0].isDeleted = true;
  authority.deletedSeqs.add(1);
  const mirror = messageThread();
  mirror.messages = [];
  mirror.syncState = {
    messageTargetSeq: 1,
    messageProcessedThroughSeq: 1,
    deletionTargetSeq: 1,
    deletionProcessedThroughSeq: 1,
    historyBoundaryReached: true,
    activeGapId: null,
  };
  mirror.historyGaps = [];
  value.p2pMessages = {
    alpha: new Map([[pair, authority]]),
    bravo: new Map([[pair, mirror]]),
    charlie: new Map(),
  };
  for (const node of ['alpha', 'bravo']) value.p2p[node].pairs.active = [pair];
  value.log.operations.push(
    {
      id: 'p2p-send',
      type: 'SEND_P2P_MESSAGE',
      status: 'SUCCEEDED',
      p2pPair: pair,
      actor: alice,
      request: { body: { clientMessageId: 'p2p-message' } },
      result: { seq: 1, originSeq: 1 },
    },
    {
      id: 'p2p-withdraw',
      type: 'WITHDRAW_P2P_MESSAGE',
      status: 'SUCCEEDED',
      withdrawnClientMessageId: 'p2p-message',
    },
  );
  return { value, pair, authority, mirror };
}

test('accepts a P2P withdrawal before the mirror fetched the message body', () => {
  const { value } = p2pWithdrawalFixture();
  assert.deepEqual(compareFederationSnapshot(value).failures, []);
});

test('accepts a P2P withdrawal after the mirror fetched the message body', () => {
  const { value, authority, mirror } = p2pWithdrawalFixture();
  mirror.messages = structuredClone(authority.messages);
  mirror.deletedSeqs.add(1);
  assert.deepEqual(compareFederationSnapshot(value).failures, []);
});

test('rejects P2P withdrawal absence without authoritative deletion and complete synchronization', () => {
  for (const mutate of [
    ({ authority }) => {
      authority.messages[0].isDeleted = false;
    },
    ({ authority }) => {
      authority.deletedSeqs.clear();
    },
    ({ mirror }) => {
      mirror.syncState.messageProcessedThroughSeq = 0;
    },
    ({ mirror }) => {
      mirror.syncState.deletionProcessedThroughSeq = 0;
    },
    ({ mirror }) => {
      mirror.syncState.historyBoundaryReached = false;
    },
    ({ mirror }) => {
      mirror.syncState.activeGapId = 1;
    },
    ({ mirror }) => {
      mirror.historyGaps = [{ startSeq: 1, endSeq: 1 }];
    },
    ({ mirror }) => {
      mirror.syncState.deletionRecoveryThroughSeq = 1;
    },
    ({ mirror }) => {
      mirror.syncState = null;
    },
    ({ value }) => {
      value.log.operations.pop();
    },
    ({ authority, mirror }) => {
      mirror.messages = structuredClone(authority.messages);
      mirror.messages[0].isDeleted = false;
    },
    ({ authority }) => {
      authority.messages = [];
    },
  ]) {
    const context = p2pWithdrawalFixture();
    mutate(context);
    assert.ok(
      compareFederationSnapshot(context.value).failures.some(
        ({ kind, operationId }) =>
          kind === 'P2P_MESSAGE_EFFECT' && operationId === 'p2p-send',
      ),
      mutate.toString(),
    );
  }
});

test('requires the referenced publisher namespace even when another copy is cached', () => {
  const value = fixture();
  const member = value.groups.bravo.groups
    .get(groupAddress)
    .roster.find(({ address }) => address === alice);
  member.namespaceId = 7;
  const cached = value.profiles.bravo.versions.get(`${alice}#1`);
  value.profiles.bravo.versions.set(`${alice}#1@8`, cached);
  let result = compareFederationSnapshot(value);
  assert.ok(
    result.failures.some(
      (failure) =>
        failure.kind === 'PROFILE_MISSING' && failure.namespaceId === 7,
    ),
  );
  value.profiles.bravo.versions.set(`${alice}#1@7`, cached);
  result = compareFederationSnapshot(value);
  assert.equal(result.passed, true);
});
