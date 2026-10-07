import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { federationLabNodes } from '../topology.mjs';
import {
  compareFinalP2pFriends,
  readP2pConsistencySnapshot,
} from './audit.mjs';
import { readGroupWorkloadSnapshot } from './group-facts.mjs';
import { parseContent } from './message-operations.mjs';
import { mediaContentEvidence } from './media-content.mjs';
import { compareCurrentMemberMessages } from './message-set-audit.mjs';
import { pairKey } from './scenario.mjs';
import { mapConcurrent } from './execute.mjs';
import {
  authorIdentity,
  quoteIdentity,
  permitsAbsentWithdrawal,
} from './message-evidence.mjs';

const labRuntimeDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'runtime',
);

function sorted(value) {
  return [...value].sort();
}

function rosterSignature(group) {
  return sorted(
    (group?.roster ?? []).map(
      ({ address, role, profileRev }) => `${address}:${role}:${profileRev}`,
    ),
  );
}

function relationSignature(group, memberAddress) {
  const relation = group?.relationships.get(memberAddress);
  return {
    active: relation?.active ?? false,
    groupIntent: relation?.groupIntent ?? null,
    userIntent: relation?.userIntent ?? null,
  };
}

function addressDomain(address) {
  return address.slice(address.lastIndexOf('@') + 1);
}

function nodeForAddress(address) {
  const node = federationLabNodes.find(
    ({ domain }) => domain === addressDomain(address),
  );
  if (!node) throw new Error(`no federation lab node owns ${address}`);
  return node;
}

export async function readNodeMessageAudit(
  client,
  node,
  kind = 'GROUP',
  { readMediaBytes = true } = {},
) {
  const identityColumns =
    kind === 'GROUP'
      ? 'thread."groupAccount" AS "account", thread."groupDomain" AS "domain"'
      : 'pair."endpointAAccount", COALESCE(ns_a."domain", \'local\') AS "endpointADomain", pair."endpointBAccount", COALESCE(ns_b."domain", \'local\') AS "endpointBDomain"';
  const identityJoin =
    kind === 'GROUP'
      ? ''
      : 'INNER JOIN "RelationshipPair" pair ON pair."threadId" = thread."id" AND pair."kind" = \'P2P\' ' +
        'LEFT JOIN "IdentityNamespace" ns_a ON ns_a."id" = pair."endpointANamespaceId" ' +
        'LEFT JOIN "IdentityNamespace" ns_b ON ns_b."id" = pair."endpointBNamespaceId"';
  const threadFilter = `WHERE thread."type" = '${kind === 'GROUP' ? 'GROUP' : 'P2P'}'`;
  const threads = await client.query(`
      SELECT ${identityColumns}, thread."id" AS "threadId",
             thread."curSeq", thread."clearedSeq", thread."authorityNamespaceId"
      FROM "MessageThread" thread
      ${identityJoin}
      ${threadFilter}
    `);
  const messages = await client.query(`
      SELECT ${identityColumns}, msg."id"::text AS "id",
             msg."threadId", msg."seq", msg."originSeq", msg."profileRev",
             msg."contentType", msg."content", msg."clientMessageId", msg."isDeleted",
             msg."localState", msg."creatorAccount", creator_ns."domain" AS "creatorDomain",
             msg."profileNamespaceId" AS "creatorNamespaceId", msg."publisherNamespaceId" AS "sourceNamespaceId", namespace."domain" AS "sourceDomain",
             quote_namespace."domain" AS "quoteSourceDomain",
             bundle."messages" AS "forwardMessages"
      FROM "Message" msg
      INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
      ${identityJoin}
      LEFT JOIN "IdentityNamespace" creator_ns ON creator_ns."id" = msg."profileNamespaceId"
      LEFT JOIN "IdentityNamespace" namespace ON namespace."id" = msg."publisherNamespaceId"
      LEFT JOIN "IdentityNamespace" quote_namespace ON quote_namespace."id" =
        CASE WHEN msg."contentType" = 'PURE_TEXT'
          THEN (msg."content"::jsonb #>> '{quote,namespaceId}')::integer END
      LEFT JOIN "ForwardMessage" carrier ON carrier."messageId" = msg."id"
      LEFT JOIN "ForwardBundle" bundle ON bundle."id" = carrier."bundleId"
      ${threadFilter}
      ORDER BY msg."threadId", msg."seq"
    `);
  const deletions = await client.query(`
      SELECT ${identityColumns}, deleted."threadId", deleted."messageSeq"
      FROM "DeletedMessage" deleted
      INNER JOIN "MessageThread" thread ON thread."id" = deleted."threadId"
      ${identityJoin}
      ${threadFilter}
    `);
  const assets = await client.query(`
      SELECT ${identityColumns}, msg."threadId", msg."id"::text AS "messageId",
             msg."clientMessageId",
             asset."digest", media."isDeleted" AS "assetDeleted", media."bytes"::text AS "assetBytes"
      FROM "MessageAsset" asset
      INNER JOIN "Message" msg ON msg."id" = asset."messageId"
      INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
      ${identityJoin}
      LEFT JOIN "MediaAsset" media ON media."digest" = asset."digest"
      ${threadFilter}
    `);
  const groupAddress = (row) =>
    kind === 'GROUP'
      ? `${row.account}@${row.domain === 'local' ? node.domain : row.domain}`
      : pairKey(
          `${row.endpointAAccount}@${row.endpointADomain === 'local' ? node.domain : row.endpointADomain}`,
          `${row.endpointBAccount}@${row.endpointBDomain === 'local' ? node.domain : row.endpointBDomain}`,
        );
  const result = new Map();
  for (const row of threads.rows) {
    result.set(groupAddress(row), {
      threadId: row.threadId,
      curSeq: row.curSeq,
      clearedSeq: row.clearedSeq,
      messages: [],
      deletedSeqs: new Set(),
      assets: [],
      syncState: null,
      syncStates: [],
      authorityNamespaceId: row.authorityNamespaceId,
      historyGaps: [],
      pendingTombstones: [],
    });
  }
  for (const row of messages.rows)
    result.get(groupAddress(row))?.messages.push(row);
  for (const row of deletions.rows)
    result.get(groupAddress(row))?.deletedSeqs.add(row.messageSeq);
  const byThread = new Map(
    [...result.values()].map((thread) => [thread.threadId, thread]),
  );
  for (const [table, property, single] of [
    ['FederationThreadSyncState', 'syncState', true],
    ['FederationThreadHistoryGap', 'historyGaps', false],
    ['FederatedMessageTombstone', 'pendingTombstones', false],
  ]) {
    const rows = await client.query(`SELECT evidence.* FROM "${table}" evidence
      INNER JOIN "MessageThread" thread ON thread."id" = evidence."threadId"
      ${identityJoin}
      ${threadFilter}`);
    for (const row of rows.rows) {
      const thread = byThread.get(row.threadId);
      if (thread) {
        if (single) {
          thread.syncStates.push(row);
          // Only the authority's coordinate space governs a mirror's history.
          // A local authority can retain multiple independent peer states.
          if (row.namespaceId === thread.authorityNamespaceId)
            thread[property] = row;
        } else thread[property].push(row);
      }
    }
  }
  const verified = new Map();
  for (const row of assets.rows) {
    if (!readMediaBytes) {
      result.get(groupAddress(row))?.assets.push(row);
      continue;
    }
    if (!verified.has(row.digest))
      verified.set(
        row.digest,
        await readAssetBytes(
          join(
            labRuntimeDir,
            node.name,
            'data',
            'cas',
            row.digest.slice(0, 2),
            row.digest.slice(2, 4),
            row.digest,
          ),
        ),
      );
    result
      .get(groupAddress(row))
      ?.assets.push({ ...row, ...verified.get(row.digest) });
  }
  return result;
}

export async function readAssetBytes(path) {
  try {
    const bytes = await readFile(path);
    return {
      diskDigest: createHash('sha256').update(bytes).digest('hex'),
      diskBytes: bytes.length,
    };
  } catch (error) {
    return {
      diskDigest: null,
      diskBytes: null,
      diskError: error.code ?? 'READ_FAILED',
    };
  }
}

async function avatarDigest(node, avatar) {
  if (!avatar) return null;
  if (!avatar.startsWith('/uploads/')) return `invalid:${avatar}`;
  const path = join(labRuntimeDir, node.name, 'data', avatar.slice(1));
  if (!existsSync(path)) return `missing:${avatar}`;
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return `invalid:${avatar}`;
  }
}

export async function readNodeProfileAudit(client, node) {
  const versions = await client.query(`
      SELECT version."profileRev", version."displayName", version."avatar", version."bio",
             version."account", ns."domain" AS "domain", version."profileNamespaceId" AS "namespaceId"
      FROM "Profile" version
      LEFT JOIN "IdentityNamespace" ns ON ns."id" = version."profileNamespaceId"
    `);
  const intents = await client.query(`
      SELECT pair."endpointAAccount", ns_a."domain" AS "endpointADomain",
             pair."endpointAType", pair."endpointBAccount", ns_b."domain" AS "endpointBDomain",
             pair."endpointBType", pair."endpointANamespaceId", pair."endpointBNamespaceId",
             CASE WHEN pair."endpointAAccount" = intent."authorAccount"
            AND pair."endpointANamespaceId" = intent."authorNamespaceId"
            THEN 'A' ELSE 'B' END AS "authorSide", intent."status", intent."expiresAt", intent."profileRev"
      FROM "RelationshipIntent" intent
      INNER JOIN "RelationshipPair" pair
      ON pair."kind" = 'P2P'
        AND (
          (pair."endpointAAccount" = intent."authorAccount"
            AND pair."endpointANamespaceId" = intent."authorNamespaceId"
            AND pair."endpointBAccount" = intent."receiverAccount"
            AND pair."endpointBNamespaceId" = intent."receiverNamespaceId")
          OR (pair."endpointBAccount" = intent."authorAccount"
            AND pair."endpointBNamespaceId" = intent."authorNamespaceId"
            AND pair."endpointAAccount" = intent."receiverAccount"
            AND pair."endpointANamespaceId" = intent."receiverNamespaceId")
        )
      LEFT JOIN "IdentityNamespace" ns_a ON ns_a."id" = pair."endpointANamespaceId"
      LEFT JOIN "IdentityNamespace" ns_b ON ns_b."id" = pair."endpointBNamespaceId"
      WHERE intent."profileRev" > 0
    `);
  const normalized = (account, domain) =>
    `${account}@${domain === 'local' ? node.domain : domain}`;
  // A foreign group may retain a source-scoped shell for a native account.
  // Local display uses the native exact version, never that foreign self copy.
  const authoritativeLocalRows = versions.rows.filter(
    (row) => row.domain !== node.domain,
  );
  const entries = await mapConcurrent(
    authoritativeLocalRows,
    4,
    async (row) => {
      const account = row.account;
      const domain = row.domain;
      const address = normalized(account, domain);
      return [
        profileKey(address, row.profileRev, row.namespaceId),
        {
          address,
          profileRev: row.profileRev,
          displayName: row.displayName,
          bio: row.bio,
          avatarDigest: await avatarDigest(node, row.avatar),
        },
      ];
    },
  );
  const now = Date.now();
  return {
    versions: new Map(entries),
    intentRefs: intents.rows
      .filter(
        (row) =>
          row.status === 'ACCEPTED' ||
          (row.status === 'REQUESTED' && Date.parse(row.expiresAt) > now),
      )
      .map((row) => ({
        address:
          row.authorSide === 'A'
            ? normalized(row.endpointAAccount, row.endpointADomain)
            : normalized(row.endpointBAccount, row.endpointBDomain),
        namespaceId:
          row.authorSide === 'A'
            ? row.endpointANamespaceId
            : row.endpointBNamespaceId,
        subjectAddress:
          row.authorSide === 'A'
            ? normalized(row.endpointBAccount, row.endpointBDomain)
            : normalized(row.endpointAAccount, row.endpointADomain),
        subjectType:
          row.authorSide === 'A' ? row.endpointBType : row.endpointAType,
        profileRev: row.profileRev,
        source: 'RELATIONSHIP_INTENT',
      })),
  };
}

export function profileKey(address, revision, namespaceId = 0) {
  return `${address}#${revision}${namespaceId === 0 ? '' : `@${namespaceId}`}`;
}

function referencedProfileKey(node, reference) {
  return profileKey(
    reference.address,
    reference.profileRev,
    addressDomain(reference.address) === node.domain
      ? 0
      : reference.namespaceId,
  );
}

function profileSignature(profile) {
  return profile
    ? {
        displayName: profile.displayName,
        bio: profile.bio,
        avatarDigest: profile.avatarDigest,
      }
    : null;
}

function expectedMessages(log) {
  const sentByClientMessageId = new Map();
  const withdrawnClientMessageIds = new Set();
  const invalid = [];
  for (const operation of log.operations) {
    if (operation.status !== 'SUCCEEDED') continue;
    const clientMessageId = operation.request?.body?.clientMessageId;
    if (clientMessageId && operation.group) {
      const authorSeq = operation.result?.seq;
      if (!Number.isSafeInteger(authorSeq) || authorSeq < 1) {
        invalid.push({
          operationId: operation.id,
          clientMessageId,
          authorSeq: authorSeq ?? null,
        });
        continue;
      }
      sentByClientMessageId.set(clientMessageId, {
        group: operation.group,
        type: operation.type,
        operationId: operation.id,
        actor: operation.actor,
        authorSeq,
        clientMessageId,
        expected: operation.expected,
        scenario: operation.scenario,
      });
    }
    if (operation.withdrawnClientMessageId)
      withdrawnClientMessageIds.add(operation.withdrawnClientMessageId);
  }
  const keyed = (entries) =>
    new Map(
      entries.map((sent) => [
        messageIdentity(sent.group, sent.actor, sent.authorSeq),
        sent,
      ]),
    );
  const sent = [...sentByClientMessageId.values()];
  return {
    live: keyed(
      sent.filter(
        ({ clientMessageId }) =>
          !withdrawnClientMessageIds.has(clientMessageId),
      ),
    ),
    withdrawn: keyed(
      sent.filter(({ clientMessageId }) =>
        withdrawnClientMessageIds.has(clientMessageId),
      ),
    ),
    invalid,
  };
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function compareMedia(node, thread, message, expected) {
  if (expected.type !== 'SEND_FILE' && expected.type !== 'SEND_GALLERY')
    return [];
  const assets = thread.assets.filter(
    ({ messageId }) => messageId === message.id,
  );
  const expectedCount = expected.type === 'SEND_FILE' ? 1 : 2;
  const errors = [];
  if (assets.length !== expectedCount)
    errors.push(`asset count ${assets.length}, expected ${expectedCount}`);
  for (const asset of assets) {
    if (asset.assetDeleted !== false)
      errors.push(`${asset.digest}: MediaAsset missing/deleted`);
    const path = join(
      labRuntimeDir,
      node.name,
      'data',
      'cas',
      asset.digest.slice(0, 2),
      asset.digest.slice(2, 4),
      asset.digest,
    );
    if (!existsSync(path)) errors.push(`${asset.digest}: CAS file missing`);
    if (asset.diskDigest !== asset.digest)
      errors.push(`${asset.digest}: CAS digest mismatch or unreadable file`);
    if (
      asset.diskBytes !== null &&
      asset.assetBytes != null &&
      BigInt(asset.assetBytes) !== BigInt(asset.diskBytes)
    )
      errors.push(`${asset.digest}: MediaAsset byte count mismatch`);
    const authored = expected.expected?.assets?.find(
      ({ digest }) => digest === asset.digest,
    );
    if (expected.expected?.assets && !authored)
      errors.push(`${asset.digest}: not in submitted asset manifest`);
    if (authored && authored.bytes !== asset.diskBytes)
      errors.push(`${asset.digest}: submitted byte count mismatch`);
  }
  return errors;
}

function messageSignature(node, message, thread, resolveQuote) {
  const creatorDomain =
    message.creatorDomain === 'local' ? node.domain : message.creatorDomain;
  const { content } = mediaContentEvidence(message);
  if (thread && content?.quote) {
    const target = thread.messages.find(({ seq }) => seq === content.quote.seq);
    content.quote = resolveQuote
      ? resolveQuote(node, message, thread)
      : target
        ? {
            actor: `${target.creatorAccount}@${target.creatorDomain === 'local' ? node.domain : target.creatorDomain}`,
            originSeq: target.originSeq,
          }
        : { missing: true };
  }
  if (message.contentType === 'FORWARD' && content) {
    delete content.bundleId;
    content.messages = message.forwardMessages;
  }
  return {
    contentType: message.contentType,
    content: content ?? message.content,
    creator: `${message.creatorAccount}@${creatorDomain}`,
  };
}

function messageIdentity(group, creator, originSeq) {
  return JSON.stringify([group, creator, originSeq]);
}

function storedMessageIdentity(node, group, message, messages) {
  const identity = authorIdentity(node, message, messages, group);
  return messageIdentity(
    group,
    messageSignature(node, message).creator,
    identity.seq,
  );
}

export function compareFederationSnapshot({
  log,
  p2p,
  groups,
  messages,
  profiles,
  p2pMessages,
  enforceCoverage = true,
  validateProfiles = true,
}) {
  const failures = [];
  const contexts = new WeakMap();
  for (const collection of [messages, p2pMessages]) {
    for (const nodeThreads of Object.values(collection ?? {}))
      for (const [key, thread] of nodeThreads)
        contexts.set(thread, { collection, key });
  }
  const resolveQuote = (node, message, thread) => {
    const context = contexts.get(thread);
    return quoteIdentity(
      node,
      message,
      thread,
      context?.collection,
      context?.key,
    );
  };
  const checkedMedia = new WeakSet();
  const signature = (node, message, thread) => {
    if (!checkedMedia.has(message)) {
      checkedMedia.add(message);
      for (const error of mediaContentEvidence(message).errors)
        failures.push({
          kind: 'MESSAGE_MEDIA_URL',
          node: node.name,
          thread: contexts.get(thread)?.key,
          threadId: message.threadId,
          seq: message.seq,
          error,
        });
    }
    return messageSignature(node, message, thread, resolveQuote);
  };
  if (
    enforceCoverage &&
    log.groups.filter(({ active }) => active).length === 2
  ) {
    if (log.referenceScenario?.status !== 'SUCCEEDED')
      failures.push({
        kind: 'WORKLOAD_COVERAGE',
        coverage: 'REFERENCE_WITHDRAWAL',
      });
    const dissolved = log.operations.filter(
      ({ type, status }) => type === 'DISSOLVE_GROUP' && status === 'SUCCEEDED',
    );
    if (dissolved.length !== 1)
      failures.push({
        kind: 'WORKLOAD_COVERAGE',
        coverage: 'ONE_ACTIVE_GROUP_DISSOLVED',
        actual: dissolved.length,
      });
  }
  const successfulTypes = countBy(
    log.operations.filter(({ status }) => status === 'SUCCEEDED'),
    ({ type }) => type,
  );
  if (enforceCoverage && log.operations.length >= 600) {
    const requirements = [
      ['GROUP_MESSAGE', successfulTypes.SEND_GROUP_MESSAGE ?? 0],
      [
        'MEDIA_MESSAGE',
        (successfulTypes.SEND_FILE ?? 0) + (successfulTypes.SEND_GALLERY ?? 0),
      ],
      ['WITHDRAWAL', successfulTypes.WITHDRAW_GROUP_MESSAGE ?? 0],
      ['USER_PROFILE_UPDATE', successfulTypes.UPDATE_USER_PROFILE ?? 0],
      ['GROUP_PROFILE_UPDATE', successfulTypes.UPDATE_GROUP_PROFILE ?? 0],
    ];
    for (const [coverage, count] of requirements)
      if (count === 0)
        failures.push({ kind: 'WORKLOAD_COVERAGE', coverage, actual: count });
  }
  const p2pPairs = Object.fromEntries(
    Object.entries(p2p).map(([nodeName, value]) => [nodeName, value.pairs]),
  );
  const p2pFriends = compareFinalP2pFriends(p2pPairs, log.users);
  if (!p2pFriends.passed)
    failures.push({ kind: 'P2P_FRIENDS', comparison: p2pFriends });
  for (let left = 0; left < log.users.length; left += 1) {
    for (let right = left + 1; right < log.users.length; right += 1) {
      const first = log.users[left];
      const second = log.users[right];
      const firstNode = nodeForAddress(first);
      const secondNode = nodeForAddress(second);
      if (firstNode.name === secondNode.name) continue;
      const directions = [
        [first, second],
        [second, first],
      ];
      for (const [author, subject] of directions) {
        const key = `${author}->${subject}`;
        const read = (nodeName) =>
          p2p[nodeName].intents.directions.find(
            (intent) => `${intent.author}->${intent.subject}` === key,
          )?.status ?? null;
        const firstStatus = read(firstNode.name);
        const secondStatus = read(secondNode.name);
        // A receiver may consume a compacted REVOKED fact before it has ever
        // materialized the pair. In that case it intentionally retains no
        // peer-authored direction. Both representations are the same inactive
        // relationship state; positive directions must still match exactly.
        const comparable = (status) => (status === 'REVOKED' ? null : status);
        if (comparable(firstStatus) !== comparable(secondStatus))
          failures.push({
            kind: 'P2P_INTENT',
            direction: key,
            values: {
              [firstNode.name]: firstStatus,
              [secondNode.name]: secondStatus,
            },
          });
      }
    }
  }

  const expected = expectedMessages(log);
  const messageSets = [];
  if (p2pMessages) {
    const pairs = new Set(
      Object.values(p2p).flatMap(({ pairs }) => pairs.active),
    );
    for (const pair of pairs) {
      const members = pair.split('|');
      const nodeNames = new Set(
        members.map((address) => nodeForAddress(address).name),
      );
      const compared = compareCurrentMemberMessages({
        groupAddress: pair,
        members,
        messages: p2pMessages,
        nodeNames,
        signature,
      });
      failures.push(
        ...compared.failures.map((failure) => ({
          ...failure,
          threadType: 'P2P',
        })),
      );
      messageSets.push({ pair, ...compared });
      for (const operation of log.operations.filter(
        (entry) =>
          entry.status === 'SUCCEEDED' &&
          entry.p2pPair === pair &&
          entry.result?.originSeq,
      )) {
        if (!operation.request?.body?.clientMessageId) continue;
        const withdrawn = log.operations.some(
          (entry) =>
            entry.status === 'SUCCEEDED' &&
            entry.withdrawnClientMessageId ===
              operation.request.body.clientMessageId,
        );
        for (const nodeName of nodeNames) {
          const node = federationLabNodes.find(({ name }) => name === nodeName);
          const thread = p2pMessages[nodeName].get(pair);
          const message = thread?.messages.find(
            (row) =>
              row.originSeq === operation.result.originSeq &&
              messageSignature(node, row).creator === operation.actor,
          );
          const absentWithdrawal =
            !message &&
            withdrawn &&
            thread &&
            permitsAbsentWithdrawal({
              nodeName,
              thread,
              messages: p2pMessages,
              key: pair,
              actor: operation.actor,
              authorSeq: operation.result.seq,
            });
          if (
            (!message && !absentWithdrawal) ||
            (message && Boolean(message.isDeleted) !== withdrawn)
          )
            failures.push({
              kind: 'P2P_MESSAGE_EFFECT',
              pair,
              node: nodeName,
              operationId: operation.id,
            });
          if (message && !withdrawn) {
            if (
              operation.expected?.text !== undefined &&
              parseContent(message.content)?.text !== operation.expected.text
            )
              failures.push({
                kind: 'P2P_MESSAGE_SUBMITTED_CONTENT',
                pair,
                node: nodeName,
                operationId: operation.id,
              });
            for (const error of compareMedia(node, thread, message, {
              type: operation.type,
              expected: operation.expected,
            }))
              failures.push({ kind: 'MEDIA', pair, node: nodeName, error });
          }
        }
      }
    }
  }
  for (const invalid of expected.invalid)
    failures.push({ kind: 'MESSAGE_JOURNAL_COORDINATE', ...invalid });
  for (const planned of log.groups) {
    const originNode = nodeForAddress(planned.address);
    const canonical = groups[originNode.name].groups.get(planned.address);
    if (!canonical) {
      failures.push({
        kind: 'GROUP_MISSING_AT_ORIGIN',
        group: planned.address,
      });
      continue;
    }
    const owners = canonical.roster.filter(({ role }) => role === 'OWNER');
    const dissolution = log.operations.find(
      (operation) =>
        operation.type === 'DISSOLVE_GROUP' &&
        operation.group === planned.address &&
        operation.status === 'SUCCEEDED',
    );
    if (
      Boolean(canonical.dissolved) !== Boolean(dissolution) ||
      (!dissolution && owners.length !== 1)
    )
      failures.push({
        kind: 'ROSTER_INVARIANT',
        group: planned.address,
        dissolved: canonical.dissolved,
        ownerCount: owners.length,
      });
    const canonicalRoster = rosterSignature(canonical);
    for (const member of log.users) {
      const rosterMember = canonical.roster.find(
        ({ address }) => address === member,
      );
      const rosterActive = Boolean(rosterMember);
      const relationshipActive = relationSignature(canonical, member).active;
      if (
        !dissolution &&
        rosterMember?.role !== 'OWNER' &&
        rosterActive !== relationshipActive
      )
        failures.push({
          kind: 'ROSTER_RELATIONSHIP',
          group: planned.address,
          member,
          rosterActive,
          relationshipActive,
        });
    }
    const finalMemberNodes = new Set([
      originNode.name,
      ...canonical.roster.map(({ address }) => nodeForAddress(address).name),
      ...(dissolution?.audienceNodes ?? []),
    ]);
    for (const nodeName of finalMemberNodes) {
      const node = federationLabNodes.find(({ name }) => name === nodeName);
      const projection = groups[node.name].groups.get(planned.address);
      // Dissolution revokes relationships but retains historical Group Meta;
      // former audiences receive no terminal empty-roster projection.
      if (
        (!dissolution || nodeName === originNode.name) &&
        Boolean(projection?.dissolved) !== Boolean(dissolution)
      )
        failures.push({
          kind: 'GROUP_DISSOLUTION',
          group: planned.address,
          node: nodeName,
          expected: Boolean(dissolution),
          actual: projection?.dissolved ?? null,
        });
      if (dissolution) {
        for (const address of dissolution.membersBeforeDissolution ?? []) {
          if (
            nodeName !== originNode.name &&
            nodeForAddress(address).name !== nodeName
          )
            continue;
          if (projection?.relationships.get(address)?.active !== false)
            failures.push({
              kind: 'DISSOLVED_MEMBERSHIP',
              group: planned.address,
              node: nodeName,
              member: address,
            });
        }
        continue;
      }
      if (projection?.defaultProfileRev !== canonical.defaultProfileRev)
        failures.push({
          kind: 'GROUP_PROFILE_REFERENCE',
          group: planned.address,
          node: nodeName,
          expected: canonical.defaultProfileRev,
          actual: projection?.defaultProfileRev,
        });
      if (
        JSON.stringify(rosterSignature(projection)) !==
        JSON.stringify(canonicalRoster)
      )
        failures.push({
          kind: 'ROSTER',
          group: planned.address,
          node: node.name,
          expected: canonicalRoster,
          actual: rosterSignature(projection),
        });
    }
    for (const member of log.users) {
      if (dissolution) break;
      const memberNode = nodeForAddress(member);
      if (memberNode.name === originNode.name) continue;
      const originRelation = relationSignature(canonical, member);
      const mirrorRelation = relationSignature(
        groups[memberNode.name].groups.get(planned.address),
        member,
      );
      if (JSON.stringify(originRelation) !== JSON.stringify(mirrorRelation))
        failures.push({
          kind: 'GROUP_INTENT',
          group: planned.address,
          member,
          expected: originRelation,
          actual: mirrorRelation,
        });
    }

    // Revoked historical members may retain an old roster or incomplete message history.
    // Dissolved groups have no current members; their terminal membership checks ran above.
    const currentMembers = new Set(
      dissolution
        ? []
        : canonical.roster
            .filter(
              ({ address, role }) =>
                canonical.relationships.get(address)?.active === true ||
                (role === 'OWNER' && !canonical.relationships.has(address)),
            )
            .map(({ address }) => address),
    );
    if (currentMembers.size === 0) continue;
    const comparedNodes = new Set([
      originNode.name,
      ...[...currentMembers].map((address) => nodeForAddress(address).name),
    ]);
    const messageSet = compareCurrentMemberMessages({
      groupAddress: planned.address,
      members: currentMembers,
      messages,
      nodeNames: comparedNodes,
      signature,
    });
    failures.push(...messageSet.failures);
    messageSets.push({ group: planned.address, ...messageSet });
    const expectedForGroup = [...expected.live].filter(
      ([, value]) =>
        value.group === planned.address && currentMembers.has(value.actor),
    );
    const expectedKeys = new Set(expectedForGroup.map(([key]) => key));
    const expectedUserCounts = countBy(
      expectedForGroup.map(([, value]) => value),
      ({ actor }) => actor,
    );
    const canonicalThread = messages[originNode.name].get(planned.address);
    const canonicalMessagesByKey = new Map(
      (canonicalThread?.messages ?? [])
        .filter(({ originSeq }) => Number.isInteger(originSeq))
        .map((message) => [
          storedMessageIdentity(originNode, planned.address, message, messages),
          message,
        ]),
    );
    for (const nodeName of comparedNodes) {
      const node = federationLabNodes.find(({ name }) => name === nodeName);
      const thread = messages[nodeName].get(planned.address);
      if (!thread) {
        failures.push({
          kind: 'MESSAGE_THREAD_MISSING',
          group: planned.address,
          node: nodeName,
        });
        continue;
      }
      for (const message of thread.messages) {
        if (
          message.contentType !== 'SYSTEM' &&
          currentMembers.has(messageSignature(node, message).creator) &&
          (!Number.isInteger(message.seq) ||
            !Number.isInteger(message.originSeq))
        )
          failures.push({
            kind: 'MESSAGE_COORDINATE',
            group: planned.address,
            node: nodeName,
            messageId: message.id,
            seq: message.seq,
            originSeq: message.originSeq,
          });
      }
      const actualWorkloadMessages = thread.messages.filter(
        (message) =>
          expectedKeys.has(
            storedMessageIdentity(node, planned.address, message, messages),
          ) &&
          message.localState === 'READY' &&
          !message.isDeleted,
      );
      const messagesByKey = new Map(
        thread.messages
          .filter(({ originSeq }) => Number.isInteger(originSeq))
          .map((message) => [
            storedMessageIdentity(node, planned.address, message, messages),
            message,
          ]),
      );
      const unexpectedMessages = thread.messages.filter(
        (message) =>
          message.contentType !== 'SYSTEM' &&
          currentMembers.has(messageSignature(node, message).creator) &&
          message.localState === 'READY' &&
          !message.isDeleted &&
          !expectedKeys.has(
            storedMessageIdentity(node, planned.address, message, messages),
          ) &&
          !expected.withdrawn.has(
            storedMessageIdentity(node, planned.address, message, messages),
          ),
      );
      for (const message of unexpectedMessages)
        failures.push({
          kind: 'MESSAGE_UNEXPECTED',
          group: planned.address,
          node: nodeName,
          messageId: message.id,
          creator: messageSignature(node, message).creator,
          originSeq: message.originSeq,
        });
      if (actualWorkloadMessages.length !== expectedForGroup.length)
        failures.push({
          kind: 'MESSAGE_COUNT',
          group: planned.address,
          node: nodeName,
          expected: expectedForGroup.length,
          actual: actualWorkloadMessages.length,
        });
      const actualUserCounts = countBy(
        actualWorkloadMessages,
        (message) => messageSignature(node, message).creator,
      );
      if (
        JSON.stringify(actualUserCounts) !== JSON.stringify(expectedUserCounts)
      )
        failures.push({
          kind: 'USER_MESSAGE_COUNT',
          group: planned.address,
          node: nodeName,
          expected: expectedUserCounts,
          actual: actualUserCounts,
        });
      for (const [messageKey, sent] of expectedForGroup) {
        const message = messagesByKey.get(messageKey);
        if (!message || message.isDeleted || message.localState !== 'READY') {
          failures.push({
            kind: 'MESSAGE_MISSING',
            group: planned.address,
            node: nodeName,
            operationId: sent.operationId,
            clientMessageId: sent.clientMessageId,
            authorSeq: sent.authorSeq,
          });
          continue;
        }
        const canonicalMessage = canonicalMessagesByKey.get(messageKey);
        if (
          canonicalMessage &&
          JSON.stringify(signature(node, message, thread)) !==
            JSON.stringify(
              signature(originNode, canonicalMessage, canonicalThread),
            )
        )
          failures.push({
            kind: 'MESSAGE_CONTENT',
            group: planned.address,
            node: nodeName,
            clientMessageId: sent.clientMessageId,
            expected: messageSignature(originNode, canonicalMessage),
            actual: messageSignature(node, message),
          });
        const content = parseContent(message.content);
        if (
          sent.expected?.text !== undefined &&
          content?.text !== sent.expected.text
        )
          failures.push({
            kind: 'MESSAGE_SUBMITTED_CONTENT',
            node: nodeName,
            group: planned.address,
            operationId: sent.operationId,
          });
        if (sent.expected?.quote) {
          const target = resolveQuote(node, message, thread);
          const observer = nodeForAddress(sent.actor);
          const observedTarget = messages[observer.name]
            ?.get(planned.address)
            ?.messages.find((row) => row.seq === sent.expected.quote.seq);
          const expectedTarget =
            sent.expected.quote.seq !== undefined
              ? observedTarget &&
                authorIdentity(
                  observer,
                  observedTarget,
                  messages,
                  planned.address,
                )
              : {
                  actor: sent.expected.quote.actor,
                  seq: sent.expected.quote.originSeq,
                };
          if (
            !target ||
            !expectedTarget ||
            expectedTarget.actor !== sent.expected.quote.actor ||
            messageIdentity(planned.address, target.actor, target.seq) !==
              messageIdentity(
                planned.address,
                expectedTarget.actor,
                expectedTarget.seq,
              )
          )
            failures.push({
              kind: 'MESSAGE_QUOTE_TARGET',
              node: nodeName,
              group: planned.address,
              operationId: sent.operationId,
            });
        }
        if (
          sent.type === 'FORWARD_HISTORY' &&
          sent.expected?.sourceText !== undefined &&
          (message.forwardMessages?.length !== 1 ||
            parseContent(message.forwardMessages[0].content)?.text !==
              sent.expected.sourceText)
        )
          failures.push({
            kind: 'FORWARD_SNAPSHOT',
            node: nodeName,
            group: planned.address,
            operationId: sent.operationId,
          });
        for (const error of compareMedia(node, thread, message, sent))
          failures.push({
            kind: 'MEDIA',
            group: planned.address,
            node: nodeName,
            clientMessageId: sent.clientMessageId,
            error,
          });
      }
      for (const [messageKey, sent] of expected.withdrawn) {
        if (sent.group !== planned.address || !currentMembers.has(sent.actor))
          continue;
        const message = messagesByKey.get(messageKey);
        if (
          (!message &&
            !permitsAbsentWithdrawal({
              nodeName,
              thread,
              messages,
              key: planned.address,
              actor: sent.actor,
              authorSeq: sent.authorSeq,
            })) ||
          (message &&
            (!message.isDeleted || !thread.deletedSeqs.has(message.seq)))
        )
          failures.push({
            kind: 'WITHDRAWAL',
            group: planned.address,
            node: nodeName,
            clientMessageId: sent.clientMessageId,
            isDeleted: message?.isDeleted,
            tombstone: message ? thread.deletedSeqs.has(message.seq) : false,
          });
      }
    }
  }
  if (validateProfiles)
    for (const node of federationLabNodes) {
      const references = [...profiles[node.name].intentRefs];
      for (const pair of p2p[node.name].pairs.active) {
        for (const message of p2pMessages?.[node.name]?.get(pair)?.messages ??
          []) {
          if (
            message.localState === 'READY' &&
            !message.isDeleted &&
            message.profileRev > 0
          )
            references.push({
              address: messageSignature(node, message).creator,
              profileRev: message.profileRev,
              namespaceId: message.creatorNamespaceId,
              source: `P2P_MESSAGE:${pair}:${message.seq}`,
            });
        }
      }
      for (const group of groups[node.name].groups.values()) {
        const originNode = nodeForAddress(group.address);
        const canonical = groups[originNode.name].groups.get(group.address);
        const canResolve =
          node.name === originNode.name ||
          (canonical &&
            !canonical.dissolved &&
            canonical.roster.some(
              ({ address }) => nodeForAddress(address).name === node.name,
            ));
        // Lazy display reads require current authorization. Historical mirrors
        // can retain unresolved references after departure or dissolution;
        // any snapshots already cached must still match their authority.
        const addGroupReference = (reference) => {
          if (
            canResolve ||
            profiles[node.name].versions.has(
              referencedProfileKey(node, reference),
            )
          )
            references.push(reference);
        };
        if (group.defaultProfileRev > 0)
          addGroupReference({
            address: group.address,
            profileRev: group.defaultProfileRev,
            namespaceId: group.namespaceId,
            source: 'GROUP_META_PROFILE',
          });
        for (const member of group.roster) {
          if (member.profileRev > 0)
            addGroupReference({
              address: member.address,
              profileRev: member.profileRev,
              namespaceId: member.namespaceId,
              source: 'GROUP_META_MEMBER',
            });
        }
        for (const message of group.messages) {
          if (
            message.localState === 'READY' &&
            !message.isDeleted &&
            message.profileRev > 0
          )
            addGroupReference({
              address: message.creatorAddress,
              profileRev: message.profileRev,
              namespaceId: message.creatorNamespaceId,
              source: `MESSAGE:${message.seq}`,
            });
        }
      }
      const seen = new Set();
      for (const reference of references) {
        const key = referencedProfileKey(node, reference);
        if (seen.has(key)) continue;
        seen.add(key);
        const actual = profiles[node.name].versions.get(key);
        const authorityNode = nodeForAddress(reference.address);
        const authoritative = profiles[authorityNode.name].versions.get(
          profileKey(reference.address, reference.profileRev),
        );
        if (!actual) {
          failures.push({
            kind: 'PROFILE_MISSING',
            node: node.name,
            ...reference,
          });
          continue;
        }
        if (!authoritative) {
          failures.push({
            kind: 'PROFILE_AUTHORITY_MISSING',
            node: authorityNode.name,
            ...reference,
          });
          continue;
        }
        if (
          [actual, authoritative].some(
            (profile) =>
              profile.avatarDigest !== null &&
              !/^[a-f0-9]{64}$/.test(profile.avatarDigest ?? ''),
          )
        )
          failures.push({
            kind: 'PROFILE_AVATAR_UNREADABLE',
            node: node.name,
            ...reference,
          });
        if (
          JSON.stringify(profileSignature(actual)) !==
          JSON.stringify(profileSignature(authoritative))
        )
          failures.push({
            kind: 'PROFILE_CONTENT',
            node: node.name,
            ...reference,
            expected: profileSignature(authoritative),
            actual: profileSignature(actual),
          });
      }
    }
  return {
    passed: failures.length === 0,
    failures,
    groups: log.groups.length,
    liveMessages: expected.live.size,
    withdrawnMessages: expected.withdrawn.size,
    liveMessagesByUser: countBy(
      [...expected.live.values()],
      ({ actor }) => actor,
    ),
    operationTypes: successfulTypes,
    p2pFriends,
    messageSets,
    auditedMessages: messageSets.reduce(
      (sum, entry) => sum + entry.sourceMessages,
      0,
    ),
  };
}

export async function readFederationAuditSnapshot(
  connections,
  log,
  options = {},
) {
  const groupAddresses = new Set(log.groups.map(({ address }) => address));
  const cohort = new Set([...log.users, ...groupAddresses]);
  const workers = await Promise.allSettled(
    [...connections.values()].map(async ({ node, client }) => {
      // One worker owns one connection; all tables on this node share one MVCC snapshot.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const single = new Map([[node.name, { node, client }]]);
        const p2p = await readP2pConsistencySnapshot(single, log.users);
        const groups = await readGroupWorkloadSnapshot(single, p2p);
        const messages = await readNodeMessageAudit(
          client,
          node,
          'GROUP',
          options,
        );
        const p2pMessages = await readNodeMessageAudit(
          client,
          node,
          'P2P',
          options,
        );
        const profiles = await readNodeProfileAudit(client, node);
        groups[node.name].groups = new Map(
          [...groups[node.name].groups].filter(([address]) =>
            groupAddresses.has(address),
          ),
        );
        profiles.intentRefs = profiles.intentRefs.filter(
          (reference) =>
            cohort.has(reference.address) &&
            cohort.has(reference.subjectAddress),
        );
        await client.query('COMMIT');
        return {
          node: node.name,
          p2p: p2p[node.name],
          groups: groups[node.name],
          messages,
          p2pMessages,
          profiles,
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }),
  );
  const failed = workers.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const entries = workers.map((result) => result.value);
  return Object.fromEntries(
    ['p2p', 'groups', 'messages', 'p2pMessages', 'profiles'].map((key) => [
      key,
      Object.fromEntries(entries.map((entry) => [entry.node, entry[key]])),
    ]),
  );
}

export async function waitForFederationConvergence({
  connections,
  log,
  timeoutMs,
  intervalMs,
  stableSamples,
  enforceCoverage = true,
  validateProfiles = true,
  onProgress = console.log,
}) {
  const deadline = Date.now() + timeoutMs;
  let samples = 0;
  let stable = 0;
  let snapshot;
  let comparison;
  while (Date.now() < deadline) {
    samples += 1;
    snapshot = await readFederationAuditSnapshot(connections, log);
    comparison = compareFederationSnapshot({
      log,
      ...snapshot,
      enforceCoverage,
      validateProfiles,
    });
    stable = comparison.passed ? stable + 1 : 0;
    onProgress(
      `[federation][oracle] sample=${samples} pass=${comparison.passed} ` +
        `stable=${stable}/${stableSamples} failures=${comparison.failures.length} ` +
        `messages=${comparison.liveMessages} withdrawn=${comparison.withdrawnMessages}`,
    );
    if (stable >= stableSamples) return { samples, snapshot, comparison };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(
    `federation state did not converge for ${stableSamples} consecutive samples within ${timeoutMs}ms`,
  );
  error.snapshot = snapshot;
  error.comparison = comparison;
  throw error;
}
