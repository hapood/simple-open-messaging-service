import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { federationLabNodes } from '../topology.mjs';
import { resolveWithRetry, waitForIncoming } from './execute.mjs';
import { parseContent } from './message-operations.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const casPath = (digest) =>
  `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
const casFile = (node, digest) =>
  new URL(
    `${node.name}/data/cas/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
    `file://${process.env.FED_LAB_RUNTIME_DIR || new URL('../runtime/', import.meta.url).pathname}/`,
  );

async function eventually(label, timeoutMs, inspect) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await inspect();
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error(`${label}: ${error.message}`, { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Compare the complete immutable descendant, independent of receiver-local bundle IDs. */
export function assertRelaySnapshot(bundle, original, expectedChildren) {
  assert.equal(
    bundle.children.length,
    expectedChildren,
    'nested bundle closure',
  );
  const children = new Map(bundle.children.map((child) => [child.id, child]));
  assert.equal(
    children.size,
    bundle.children.length,
    'unique child bundle IDs',
  );
  const reachable = new Set();
  const visit = (current, ancestors = new Set()) => {
    for (const message of current.messages) {
      if (!message.childBundleId) continue;
      const id = message.childBundleId;
      assert(!ancestors.has(id), 'no cyclic bundle references');
      assert(children.has(id), 'every child reference resolves locally');
      reachable.add(id);
      visit(children.get(id), new Set([...ancestors, id]));
    }
  };
  visit(bundle);
  assert.equal(reachable.size, children.size, 'all descendants are reachable');
  const candidates = [bundle, ...bundle.children];
  assert(
    candidates.some(({ messages }) => {
      try {
        assert.deepEqual(messages, original.messages);
        return true;
      } catch {
        return false;
      }
    }),
    'original profile/content snapshot must survive every relay',
  );
  const digests = bundle.assets.map(({ digest }) => digest);
  assert.equal(
    new Set(digests).size,
    digests.length,
    'asset manifest is deduplicated',
  );
  for (const asset of original.assets)
    assert.deepEqual(
      bundle.assets.find(({ digest }) => digest === asset.digest),
      asset,
    );
}

/** Read through the client projection: stored mirror content holds a local bundle id. */
export async function readForwardRelayBundle(actor, row) {
  const page = await actor.post(
    '/query-messages',
    {
      threadId: row.threadId,
      after: row.seq - 1,
      through: row.seq,
      take: 1,
    },
    'read forward carrier projection',
  );
  const carrier = page.messages.find((message) => message.seq === row.seq);
  assert(carrier, 'forward carrier must be visible in the client projection');
  return actor.forwardBundle(parseContent(carrier.content).bundleId);
}

/** Provision alongside the ordinary workload users under the same OTP rate-limit policy. */
export async function provisionForwardRelayUsers(actors) {
  const suffix = randomUUID().slice(0, 8);
  const users = [];
  for (const [index, node] of [
    ...federationLabNodes,
    federationLabNodes[2],
  ].entries()) {
    users.push(
      await actors.createAndLoginUser(node.name, {
        account: `relay${suffix}${index}`,
        name: `Relay ${index}`,
      }),
    );
  }
  return users;
}

/** Dedicated users keep cold-cache prerequisites independent of random group membership. */
export async function executeForwardRelayScenario({
  users,
  connections,
  log,
  timeoutMs = 120_000,
  onLog = async () => {},
  onProgress = console.log,
}) {
  const report = (log.forwardRelayScenario = {
    status: 'RUNNING',
    users: users.map((user) => user.address),
    operations: [],
    cases: [],
  });
  const save = () => onLog(log);
  const client = (actor) => connections.get(actor.node.name).client;
  const record = async (actor, endpoint, body) => {
    const { avatarBase64, ...journalBody } = body;
    const operation = {
      actor: actor.address,
      endpoint,
      body: avatarBase64
        ? {
            ...journalBody,
            avatarSha256: sha256(Buffer.from(avatarBase64, 'base64')),
          }
        : {
            ...journalBody,
            ...(avatarBase64 === null ? { avatarBase64: null } : {}),
          },
      status: 'RUNNING',
    };
    report.operations.push(operation);
    await save();
    const result = await actor.post(endpoint, body, 'three-node forward relay');
    operation.result = result;
    operation.status = result?.taskId ? 'ADMITTED' : 'SUCCEEDED';
    await save();
    return result;
  };
  const mirrored = (viewer, threadId, author, sent) =>
    eventually(
      `message ${author.address}/${sent.seq} on ${viewer.node.name}`,
      timeoutMs,
      async () => {
        const publisherNamespaceId = await namespaceId(viewer, author);
        const { rows } = await client(viewer).query(
          `SELECT * FROM "Message" WHERE "threadId" = $1 AND "creatorAccount" = $2
         AND "publisherNamespaceId" = $3 AND "profileNamespaceId" = 0
         AND ${viewer.node.name === author.node.name ? 'seq' : '"originSeq"'} = $4`,
          [threadId, author.account, publisherNamespaceId, sent.seq],
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].localState, 'READY');
        return rows[0];
      },
    );
  const namespaceId = (viewer, subject) =>
    eventually(
      `${subject.domain} namespace on ${viewer.node.name}`,
      timeoutMs,
      async () => {
        if (viewer.node.name === subject.node.name) return 0;
        const { rows } = await client(viewer).query(
          `SELECT id FROM "IdentityNamespace" WHERE domain = $1 AND active`,
          [subject.domain],
        );
        assert.equal(rows.length, 1);
        assert(Number.isInteger(rows[0].id));
        return rows[0].id;
      },
    );
  const befriend = async (left, right) => {
    const resolvedRight = await resolveWithRetry(left, right, timeoutMs);
    const rightNamespaceId = await namespaceId(left, right);
    await record(left, '/relationship/request', {
      account: right.account,
      namespaceId: rightNamespaceId,
      snapshot: {
        displayName: resolvedRight.user.name,
        avatar: resolvedRight.user.avatar || null,
      },
    });
    const incoming = await waitForIncoming(right, left, timeoutMs);
    await record(right, '/relationship/accept', {
      requestId: incoming.requestId,
    });
    return eventually(
      `friendship ${left.address}/${right.address}`,
      timeoutMs,
      async () => {
        const threads = [];
        for (const [viewer, peer] of [
          [left, right],
          [right, left],
        ]) {
          const peerNamespaceId = await namespaceId(viewer, peer);
          const { rows } = await client(viewer).query(
            `SELECT "threadId" FROM "RelationshipPair" WHERE kind = 'P2P' AND active
           AND "endpointAAccount" = $1 AND "endpointANamespaceId" = 0
           AND "endpointBAccount" = $2 AND "endpointBNamespaceId" = $3`,
            [viewer.account, peer.account, peerNamespaceId],
          );
          assert.equal(rows.length, 1);
          assert(Number.isInteger(rows[0].threadId));
          threads.push(rows[0].threadId);
        }
        return threads;
      },
    );
  };
  const send = (actor, threadId, text) =>
    record(actor, '/send-message', {
      threadId,
      clientMessageId: randomUUID(),
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text }),
    });
  const forward = (actor, threadId, sourceMessages, mode = 'HISTORY') =>
    record(actor, '/send-forward', {
      threadId,
      sourceMessages,
      mode,
      clientMessageId: randomUUID(),
    });
  const view = readForwardRelayBundle;
  try {
    const [a, b, c, outsider] = users;
    const [threadA, threadBA] = await befriend(a, b);
    const [threadBC, threadC] = await befriend(b, c);
    const control = await send(
      b,
      threadBC,
      'Unrelated message cannot authorize snapshot assets',
    );
    const controlC = await mirrored(c, threadC, b, control);

    for (const variant of ['DIRECT', 'HISTORY', 'DEEP_HISTORY']) {
      onProgress(`[p2p][forward-relay] ${variant}: B source → A → B → C`);
      const evidence = { variant, status: 'RUNNING' };
      report.cases.push(evidence);
      // Random pixel bytes make the cold-cache assertion meaningful even on an existing lab.
      const pixels = Buffer.from(randomUUID().replaceAll('-', ''), 'hex');
      const png = await sharp(pixels, {
        raw: { width: 2, height: 2, channels: 4 },
      })
        .png()
        .toBuffer();
      const originalName = `Snapshot ${variant}`;
      // Keep avatar bytes out of the operation journal; the expected digest is recorded below.
      await record(b, '/user/update-profile', {
        name: originalName,
        bio: '',
        avatarBase64: png.toString('base64'),
      });
      const sourceProfile = await b.resolveOwnProfile();
      const avatarResponse = await fetch(
        `${b.node.backendBaseUrl}${sourceProfile.avatar}`,
        {
          headers: { Authorization: `Bearer ${b.token}` },
          signal: AbortSignal.timeout(30_000),
        },
      );
      assert.equal(avatarResponse.status, 200);
      const avatarBytes = Buffer.from(await avatarResponse.arrayBuffer());
      const digest = sha256(avatarBytes);
      evidence.avatarDigest = digest;
      const sources = [];
      for (let index = 0; index < 2; index++) {
        const sent = await send(
          b,
          threadBA,
          `${variant} remote original ${index}`,
        );
        sources.push(await mirrored(a, threadA, b, sent));
      }
      await eventually('source profile localized on A', timeoutMs, async () => {
        const publisherNamespaceId = await namespaceId(a, b);
        const { rows } = await client(a).query(
          `SELECT * FROM "Profile" WHERE account = $1
           AND "publisherNamespaceId" = $2 AND "profileNamespaceId" = 0
           AND "profileRev" = $3`,
          [b.account, publisherNamespaceId, sources[0].profileRev],
        );
        assert(
          rows.some((row) => row.displayName === originalName && row.avatar),
        );
      });
      const local = await send(
        a,
        threadA,
        `${variant} author only known to relay`,
      );
      const first = await forward(
        a,
        threadA,
        [...sources, local].map(({ seq }) => ({ threadId: threadA, seq })),
      );
      const original = await view(a, first);
      assert.equal(original.messages.length, 3);
      assert.deepEqual(original.messages[0].profile, {
        displayName: originalName,
        avatarDigest: digest,
      });
      for (const snapshot of original.messages) {
        assert.equal(Object.hasOwn(snapshot, 'author'), false);
        assert.equal(Object.hasOwn(snapshot, 'account'), false);
        assert.equal(Object.hasOwn(snapshot, 'domain'), false);
        assert.equal(Object.hasOwn(snapshot, 'publicRootKey'), false);
      }
      // A never publishes a profile: the relayed snapshot carries the
      // account-facts fallback (account as displayName), not a provisioned name.
      assert.deepEqual(original.messages[2].profile, {
        displayName: a.account,
      });
      assert.deepEqual(
        original.messages.map(({ content }) => parseContent(content).text),
        [
          `${variant} remote original 0`,
          `${variant} remote original 1`,
          `${variant} author only known to relay`,
        ],
      );
      assert(
        original.assets.some(
          (asset) =>
            asset.digest === digest && asset.bytes === avatarBytes.length,
        ),
      );
      let relay = await mirrored(b, threadBA, a, first);
      assertRelaySnapshot(await view(b, relay), original, 0);
      // Later profile updates must not rewrite the already captured name/avatar.
      await record(b, '/user/update-profile', {
        name: `Changed ${variant}`,
        bio: '',
        avatarBase64: null,
      });
      if (variant === 'DEEP_HISTORY') {
        const back = await forward(b, threadBA, [
          { threadId: threadBA, seq: relay.seq },
        ]);
        await mirrored(a, threadA, b, back);
        relay = back;
      }
      const cold = await client(c).query(
        'SELECT digest FROM "MediaAsset" WHERE digest = $1',
        [digest],
      );
      assert.equal(
        cold.rows.length,
        0,
        'C must not have the source avatar CAS row',
      );
      await assert.rejects(stat(casFile(c.node, digest)), { code: 'ENOENT' });
      const unknownA = await client(c).query(
        'SELECT 1 FROM "Profile" WHERE account = $1',
        [a.account],
      );
      assert.equal(
        unknownA.rows.length,
        0,
        'C must not resolve A to display its snapshot',
      );
      evidence.coldCache = true;
      const sent = await forward(
        b,
        threadBC,
        [{ threadId: threadBA, seq: relay.seq }],
        variant === 'DIRECT' ? 'DIRECT' : 'HISTORY',
      );
      const received = await mirrored(c, threadC, b, sent);
      const bundle = await view(c, received);
      assertRelaySnapshot(
        bundle,
        original,
        variant === 'DIRECT' ? 0 : variant === 'HISTORY' ? 1 : 2,
      );
      const imported = await client(c).query(
        `SELECT "sourceDomain" FROM "ForwardBundle"
         WHERE "sourceBundleId" = $1 AND "sourceDomain" = $2`,
        [bundle.id, b.domain],
      );
      assert.equal(imported.rows.length, 1);
      assert.equal(
        imported.rows[0]?.sourceDomain,
        b.domain,
        'C imports the bundle from its immediate relay B',
      );
      assert.deepEqual(bundle.accessContext, {
        threadId: threadC,
        seq: received.seq,
      });
      evidence.context = bundle.accessContext;
      evidence.bundleId = bundle.id;
      evidence.original = original;
      evidence.expectedChildren = bundle.children.length;
      for (const asset of bundle.assets) {
        // Bundle JSON can be visible before its asynchronous binary transfers finish.
        // Wait on local storage, then test HTTP authorization without retrying denials.
        const localBytes = await eventually(
          'C materializes relay asset',
          timeoutMs,
          async () => {
            const { rows } = await client(c).query(
              'SELECT bytes FROM "MediaAsset" WHERE digest = $1 AND "isDeleted" = false',
              [asset.digest],
            );
            assert.equal(Number(rows[0]?.bytes), asset.bytes);
            const bytes = await readFile(casFile(c.node, asset.digest));
            assert.equal(bytes.length, asset.bytes);
            assert.equal(sha256(bytes), asset.digest);
            return bytes;
          },
        );
        const response = await fetch(
          `${c.node.backendBaseUrl}${casPath(asset.digest)}?${new URLSearchParams(bundle.accessContext)}`,
          {
            headers: { Authorization: `Bearer ${c.token}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        assert.equal(
          response.status,
          200,
          `C downloads localized asset ${asset.digest}`,
        );
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(bytes.length, asset.bytes);
        assert.equal(sha256(bytes), asset.digest);
        assert.deepEqual(localBytes, bytes);
        if (asset.digest === digest) assert.deepEqual(bytes, avatarBytes);
      }
      const denied = [];
      for (const [label, viewer, context, status] of [
        ['digest-only', c, undefined, 404],
        ['unrelated-message', c, { threadId: threadC, seq: controlC.seq }, 404],
        ['outsider', outsider, bundle.accessContext, 404],
        ['anonymous', null, bundle.accessContext, 401],
      ]) {
        const response = await fetch(
          `${c.node.backendBaseUrl}${casPath(digest)}${context ? `?${new URLSearchParams(context)}` : ''}`,
          {
            headers: viewer ? { Authorization: `Bearer ${viewer.token}` } : {},
            signal: AbortSignal.timeout(30_000),
          },
        );
        await response.arrayBuffer();
        assert.equal(
          response.status,
          status,
          `${label} must not download an existing avatar`,
        );
        denied.push({ label, status });
      }
      const stillUnknown = await client(c).query(
        'SELECT 1 FROM "Profile" WHERE account = $1',
        [a.account],
      );
      assert.equal(stillUnknown.rows.length, 0);
      Object.assign(evidence, {
        status: 'SUCCEEDED',
        assetsVerified: bundle.assets.length,
        denied,
      });
      await save();
    }
    report.status = 'SUCCEEDED';
    onProgress(
      '[p2p][forward-relay] all three relay cases and download authorization checks passed',
    );
  } catch (error) {
    report.status = 'FAILED';
    report.error = error.message;
    throw error;
  } finally {
    await save();
  }
}
