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
    (group?.roster ?? []).map(({ address, role }) => `${address}:${role}`),
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

export async function readNodeMessageAudit(client, node) {
  const threads = await client.query(`
      SELECT grp."account", grp."domain", thread."id" AS "threadId",
             thread."curSeq", thread."clearedSeq"
      FROM "Group" grp
      INNER JOIN "MessageThread" thread ON thread."groupId" = grp."id"
    `);
  const messages = await client.query(`
      SELECT grp."account", grp."domain", msg."id"::text AS "id",
             msg."threadId", msg."seq", msg."originSeq",
             msg."contentType", msg."content", msg."clientMessageId", msg."isDeleted",
             msg."localState", msg."creatorAccount", msg."creatorDomain"
      FROM "Message" msg
      INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
      INNER JOIN "Group" grp ON grp."id" = thread."groupId"
      ORDER BY msg."threadId", msg."seq"
    `);
  const deletions = await client.query(`
      SELECT grp."account", grp."domain", deleted."threadId", deleted."messageSeq"
      FROM "DeletedMessage" deleted
      INNER JOIN "MessageThread" thread ON thread."id" = deleted."threadId"
      INNER JOIN "Group" grp ON grp."id" = thread."groupId"
    `);
  const assets = await client.query(`
      SELECT grp."account", grp."domain", msg."threadId", msg."id"::text AS "messageId",
             msg."clientMessageId",
             asset."digest", media."isDeleted" AS "assetDeleted",
             progress."status" AS "syncStatus"
      FROM "MessageAsset" asset
      INNER JOIN "Message" msg ON msg."id" = asset."messageId"
      INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
      INNER JOIN "Group" grp ON grp."id" = thread."groupId"
      LEFT JOIN "MediaAsset" media ON media."digest" = asset."digest"
      LEFT JOIN "FileSyncProgress" progress
        ON progress."batchId"::text = msg."clientMessageId"
       AND progress."digest" = asset."digest"
    `);
  const groupAddress = (row) =>
    `${row.account}@${row.domain === 'local' ? node.domain : row.domain}`;
  const result = new Map();
  for (const row of threads.rows) {
    result.set(groupAddress(row), {
      threadId: row.threadId,
      curSeq: row.curSeq,
      clearedSeq: row.clearedSeq,
      messages: [],
      deletedSeqs: new Set(),
      assets: [],
    });
  }
  for (const row of messages.rows)
    result.get(groupAddress(row))?.messages.push(row);
  for (const row of deletions.rows)
    result.get(groupAddress(row))?.deletedSeqs.add(row.messageSeq);
  for (const row of assets.rows)
    result.get(groupAddress(row))?.assets.push(row);
  return result;
}

async function readMessageAudit(connections) {
  const entries = await Promise.all(
    [...connections.values()].map(async ({ node, client }) => [
      node.name,
      await readNodeMessageAudit(client, node),
    ]),
  );
  return Object.fromEntries(entries);
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

async function readNodeProfileAudit(client, node) {
  const versions = await client.query(`
      SELECT version."profileRev", version."displayName", version."avatar", version."bio",
             usr."account" AS "userAccount", usr."domain" AS "userDomain",
             grp."account" AS "groupAccount", grp."domain" AS "groupDomain"
      FROM "ProfileVersion" version
      LEFT JOIN "User" usr ON usr."id" = version."userId"
      LEFT JOIN "Group" grp ON grp."id" = version."groupId"
    `);
  const intents = await client.query(`
      SELECT pair."endpointAAccount", pair."endpointADomain",
             pair."endpointAType", pair."endpointBAccount", pair."endpointBDomain",
             pair."endpointBType",
             intent."authorSide", intent."status", intent."expiresAt", intent."profileRev"
      FROM "RelationshipIntent" intent
      INNER JOIN "RelationshipPair" pair ON pair."id" = intent."pairId"
      WHERE intent."profileRev" > 0
    `);
  const normalized = (account, domain) =>
    `${account}@${domain === 'local' ? node.domain : domain}`;
  const entries = await Promise.all(
    versions.rows.map(async (row) => {
      const account = row.userAccount ?? row.groupAccount;
      const domain = row.userAccount ? row.userDomain : row.groupDomain;
      const address = normalized(account, domain);
      return [
        `${address}#${row.profileRev}`,
        {
          address,
          profileRev: row.profileRev,
          displayName: row.displayName,
          bio: row.bio,
          avatarDigest: await avatarDigest(node, row.avatar),
        },
      ];
    }),
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

async function readProfileAudit(connections) {
  const entries = await Promise.all(
    [...connections.values()].map(async ({ node, client }) => [
      node.name,
      await readNodeProfileAudit(client, node),
    ]),
  );
  return Object.fromEntries(entries);
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
      const originSeq = operation.result?.originSeq;
      if (!Number.isInteger(originSeq)) {
        invalid.push({
          operationId: operation.id,
          clientMessageId,
          originSeq: originSeq ?? null,
        });
        continue;
      }
      sentByClientMessageId.set(clientMessageId, {
        group: operation.group,
        type: operation.type,
        operationId: operation.id,
        actor: operation.actor,
        originSeq,
        clientMessageId,
      });
    }
    if (operation.withdrawnClientMessageId)
      withdrawnClientMessageIds.add(operation.withdrawnClientMessageId);
  }
  const keyed = (entries) =>
    new Map(
      entries.map((sent) => [
        messageIdentity(sent.group, sent.actor, sent.originSeq),
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

function compareSequenceCoverage(thread) {
  const visible = new Set(
    thread.messages
      .filter(
        ({ localState, isDeleted }) => localState === 'READY' && !isDeleted,
      )
      .map(({ seq }) => seq),
  );
  const unexplained = [];
  for (let seq = (thread.clearedSeq ?? 0) + 1; seq <= thread.curSeq; seq += 1) {
    if (!visible.has(seq) && !thread.deletedSeqs.has(seq))
      unexplained.push(seq);
  }
  return unexplained;
}

function compareMedia(node, thread, message, expected) {
  if (expected.type !== 'SEND_FILE' && expected.type !== 'SEND_GALLERY')
    return [];
  const assets = thread.assets.filter(
    ({ messageId }) => messageId === message.id,
  );
  const expectedCount = expected.type === 'SEND_FILE' ? 1 : 2;
  const creatorDomain =
    message.creatorDomain === 'local' ? node.domain : message.creatorDomain;
  const isLocalSource = creatorDomain === node.domain;
  const errors = [];
  if (assets.length !== expectedCount)
    errors.push(`asset count ${assets.length}, expected ${expectedCount}`);
  for (const asset of assets) {
    if (asset.assetDeleted !== false)
      errors.push(`${asset.digest}: MediaAsset missing/deleted`);
    if (!isLocalSource && asset.syncStatus !== 'SUCCEEDED')
      errors.push(`${asset.digest}: sync=${asset.syncStatus ?? 'missing'}`);
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
  }
  return errors;
}

function messageSignature(node, message) {
  const creatorDomain =
    message.creatorDomain === 'local' ? node.domain : message.creatorDomain;
  return {
    contentType: message.contentType,
    content: message.content,
    creator: `${message.creatorAccount}@${creatorDomain}`,
  };
}

function messageIdentity(group, creator, originSeq) {
  return JSON.stringify([group, creator, originSeq]);
}

function storedMessageIdentity(node, group, message) {
  return messageIdentity(
    group,
    messageSignature(node, message).creator,
    message.originSeq,
  );
}

export function compareFederationSnapshot({
  log,
  p2p,
  groups,
  messages,
  profiles,
  enforceCoverage = true,
  validateProfiles = true,
}) {
  const failures = [];
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
        if (read(firstNode.name) !== read(secondNode.name))
          failures.push({
            kind: 'P2P_INTENT',
            direction: key,
            values: {
              [firstNode.name]: read(firstNode.name),
              [secondNode.name]: read(secondNode.name),
            },
          });
      }
    }
  }

  const expected = expectedMessages(log);
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
    if (canonical.dissolved || owners.length !== 1)
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
      if (rosterMember?.role !== 'OWNER' && rosterActive !== relationshipActive)
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
    ]);
    for (const nodeName of finalMemberNodes) {
      const node = federationLabNodes.find(({ name }) => name === nodeName);
      const projection = groups[node.name].groups.get(planned.address);
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

    const expectedForGroup = [...expected.live].filter(
      ([, value]) => value.group === planned.address,
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
          storedMessageIdentity(originNode, planned.address, message),
          message,
        ]),
    );
    for (const nodeName of finalMemberNodes) {
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
      const unexplained = compareSequenceCoverage(thread);
      if (unexplained.length > 0)
        failures.push({
          kind: 'MESSAGE_SEQ_GAP',
          group: planned.address,
          node: nodeName,
          unexplained,
        });
      for (const message of thread.messages) {
        if (
          message.contentType !== 'SYSTEM' &&
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
            storedMessageIdentity(node, planned.address, message),
          ) &&
          message.localState === 'READY' &&
          !message.isDeleted,
      );
      const messagesByKey = new Map(
        thread.messages
          .filter(({ originSeq }) => Number.isInteger(originSeq))
          .map((message) => [
            storedMessageIdentity(node, planned.address, message),
            message,
          ]),
      );
      const unexpectedMessages = thread.messages.filter(
        (message) =>
          message.contentType !== 'SYSTEM' &&
          message.localState === 'READY' &&
          !message.isDeleted &&
          !expectedKeys.has(
            storedMessageIdentity(node, planned.address, message),
          ) &&
          !expected.withdrawn.has(
            storedMessageIdentity(node, planned.address, message),
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
            originSeq: sent.originSeq,
          });
          continue;
        }
        const canonicalMessage = canonicalMessagesByKey.get(messageKey);
        if (
          canonicalMessage &&
          JSON.stringify(messageSignature(node, message)) !==
            JSON.stringify(messageSignature(originNode, canonicalMessage))
        )
          failures.push({
            kind: 'MESSAGE_CONTENT',
            group: planned.address,
            node: nodeName,
            clientMessageId: sent.clientMessageId,
            expected: messageSignature(originNode, canonicalMessage),
            actual: messageSignature(node, message),
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
        if (sent.group !== planned.address) continue;
        const message = messagesByKey.get(messageKey);
        if (
          message &&
          (!message.isDeleted || !thread.deletedSeqs.has(message.seq))
        )
          failures.push({
            kind: 'WITHDRAWAL',
            group: planned.address,
            node: nodeName,
            clientMessageId: sent.clientMessageId,
            isDeleted: message.isDeleted,
            tombstone: thread.deletedSeqs.has(message.seq),
          });
      }
    }
  }
  if (validateProfiles)
    for (const node of federationLabNodes) {
      const references = [...profiles[node.name].intentRefs];
      for (const group of groups[node.name].groups.values()) {
        if (group.defaultProfileRev > 0)
          references.push({
            address: group.address,
            profileRev: group.defaultProfileRev,
            source: 'GROUP_META_PROFILE',
          });
        for (const member of group.roster) {
          if (member.profileRev > 0)
            references.push({
              address: member.address,
              profileRev: member.profileRev,
              source: 'GROUP_META_MEMBER',
            });
        }
        for (const message of group.messages) {
          if (
            message.localState === 'READY' &&
            !message.isDeleted &&
            message.profileRev > 0
          )
            references.push({
              address: message.creatorAddress,
              profileRev: message.profileRev,
              source: `MESSAGE:${message.seq}`,
            });
        }
      }
      const seen = new Set();
      for (const reference of references) {
        const key = `${reference.address}#${reference.profileRev}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const actual = profiles[node.name].versions.get(key);
        const authorityNode = nodeForAddress(reference.address);
        const authoritative = profiles[authorityNode.name].versions.get(key);
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
  };
}

export async function readFederationAuditSnapshot(connections, log) {
  const p2p = await readP2pConsistencySnapshot(connections, log.users);
  const groups = await readGroupWorkloadSnapshot(connections, p2p);
  const messages = await readMessageAudit(connections);
  const profiles = await readProfileAudit(connections);
  return { p2p, groups, messages, profiles };
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
