import {
  federationLabNodeForDomain,
  federationLabNodes,
} from '../topology.mjs';
import { pairKey } from './scenario.mjs';
import { profileSubjectIdentityJoins } from './profile-subject-identity.mjs';

function normalizeAddress(account, domain) {
  return `${account}@${domain}`;
}

function addressParts(address) {
  const separator = address.lastIndexOf('@');
  return {
    account: address.slice(0, separator),
    domain: address.slice(separator + 1),
  };
}

async function readNodeGroupRows(client) {
  // node-postgres serializes a client's queries itself. Await them explicitly
  // instead of relying on the deprecated concurrent-query queueing behavior.
  const groups = await client.query(`
        SELECT thread."id" AS "groupId", thread."groupAccount" AS "account",
               authority_ns."domain" AS "domain", thread."authorityNamespaceId" AS "namespaceId",
               COALESCE(profile."displayName", thread."groupAccount") AS "name",
               COALESCE(profile."bio", '') AS "description",
               COALESCE(profile."avatar", '') AS "avatar",
               COALESCE(account."defaultProfileRev", meta."profileRev", 0) AS "defaultProfileRev",
               COALESCE(account."dissolvedAt", thread."groupDissolvedAt") AS "dissolvedAt",
               thread."id" AS "threadId"
        FROM "MessageThread" thread
        INNER JOIN "IdentityNamespace" authority_ns
          ON authority_ns."id" = thread."authorityNamespaceId"
        LEFT JOIN "GroupAccount" account ON account."id" = thread."groupAccountId"
        LEFT JOIN "GroupMeta" meta ON meta."threadId" = thread."id"
        LEFT JOIN "Profile" profile ON profile."account" = thread."groupAccount"
          AND profile."publisherNamespaceId" = thread."authorityNamespaceId"
          AND profile."profileNamespaceId" = 0
          AND profile."profileRev" = COALESCE(account."defaultProfileRev", meta."profileRev", 0)
        WHERE thread."type" = 'GROUP'
        ORDER BY thread."id"
      `);
  const roster = await client.query(`
        SELECT fact."threadId", fact."body" ->> 'account' AS "account",
          CASE
            WHEN subject."namespaceId" = 0 THEN authority_ns."domain"
            WHEN subject."namespaceId" = authority_ns."peerAssignedLocalNamespaceId"
              THEN local_ns."domain"
            WHEN thread."authorityNamespaceId" = 0 THEN identity_ns."domain"
            ELSE profile_identity.domain
          END AS "domain",
          CASE
            WHEN subject."namespaceId" = 0 THEN thread."authorityNamespaceId"
            WHEN subject."namespaceId" = authority_ns."peerAssignedLocalNamespaceId"
              THEN 0
            ELSE profile_identity.id
          END AS "namespaceId",
          subject."namespaceId" AS "profileNamespaceId",
          fact."body" ->> 'role' AS "role",
          (fact."body" ->> 'profileRev')::integer AS "profileRev"
        FROM "GroupMetaMemberFeed" fact
        CROSS JOIN LATERAL (
          SELECT (fact."body" ->> 'namespaceId')::integer AS "namespaceId"
        ) subject
        INNER JOIN "MessageThread" thread ON thread."id" = fact."threadId"
        INNER JOIN "IdentityNamespace" authority_ns
          ON authority_ns."id" = thread."authorityNamespaceId"
        INNER JOIN "IdentityNamespace" local_ns ON local_ns."id" = 0
        LEFT JOIN "IdentityNamespace" identity_ns
          ON identity_ns."id" = subject."namespaceId"
        ${profileSubjectIdentityJoins('thread."authorityNamespaceId"', 'subject."namespaceId"', 'profile_identity')}
        WHERE fact."operation" = 'MEMBER_UPSERT'
      `);
  const relationships = await client.query(`
        SELECT pair."id"::text, pair."active", pair."threadId",
               pair."endpointAType", pair."endpointAAccount",
               ns_a."domain" AS "endpointADomain",
               pair."endpointBType", pair."endpointBAccount",
               ns_b."domain" AS "endpointBDomain",
               CASE WHEN intent."authorAccount" IS NULL THEN NULL
                 WHEN pair."endpointAAccount" = intent."authorAccount"
                   AND pair."endpointANamespaceId" = intent."authorNamespaceId"
                 THEN 'A' ELSE 'B' END AS "authorSide",
               intent."status", intent."expiresAt"
        FROM "RelationshipPair" pair
        LEFT JOIN "IdentityNamespace" ns_a ON ns_a."id" = pair."endpointANamespaceId"
        LEFT JOIN "IdentityNamespace" ns_b ON ns_b."id" = pair."endpointBNamespaceId"
        LEFT JOIN "RelationshipIntent" intent
          ON (pair."endpointAAccount" = intent."authorAccount"
            AND pair."endpointANamespaceId" = intent."authorNamespaceId"
            AND pair."endpointBAccount" = intent."receiverAccount"
            AND pair."endpointBNamespaceId" = intent."receiverNamespaceId")
          OR (pair."endpointBAccount" = intent."authorAccount"
            AND pair."endpointBNamespaceId" = intent."authorNamespaceId"
            AND pair."endpointAAccount" = intent."receiverAccount"
            AND pair."endpointANamespaceId" = intent."receiverNamespaceId")
        WHERE pair."kind" = 'GROUP_MEMBER'
        ORDER BY pair."id", "authorSide"
      `);
  const requests = await client.query(`
        SELECT projection."threadId", projection."direction", projection."feedId",
               projection."status", projection."expiresAt",
               projection."memberAccount", projection."profileNamespaceId" AS "memberNamespaceId",
               ns."domain" AS "memberDomain"
        FROM "GroupRequestProjection" projection
        LEFT JOIN "IdentityNamespace" ns ON ns."id" = projection."profileNamespaceId"
        ORDER BY projection."threadId", projection."direction", projection."feedId"
      `);
  const users = await client.query(`
        SELECT local_account."id", identity."account", identity."domain"
        FROM (
          SELECT "account", ns0."domain" FROM "Account" "Account"
          JOIN "IdentityNamespace" ns0 ON ns0."id" = 0
          UNION
          SELECT pair."endpointAAccount", ns_a."domain"
          FROM "RelationshipPair" pair
          LEFT JOIN "IdentityNamespace" ns_a ON ns_a."id" = pair."endpointANamespaceId"
          WHERE pair."endpointAType" = 'USER'
          UNION
          SELECT pair."endpointBAccount", ns_b."domain"
          FROM "RelationshipPair" pair
          LEFT JOIN "IdentityNamespace" ns_b ON ns_b."id" = pair."endpointBNamespaceId"
          WHERE pair."endpointBType" = 'USER'
        ) identity
        LEFT JOIN "IdentityNamespace" home ON home."id" = 0
        LEFT JOIN "Account" local_account ON identity."domain" = home."domain"
          AND local_account."account" = identity."account"
        ORDER BY identity."domain", identity."account"
      `);
  const messages = await client.query(`
        SELECT msg."id"::text, msg."threadId", msg."seq", msg."originSeq", msg."profileRev",
               msg."contentType", msg."content", msg."clientMessageId",
               msg."creatorAccount", creator_ns."domain" AS "creatorDomain",
               creator_ns."id" AS "creatorNamespaceId", msg."profileNamespaceId",
               msg."publisherNamespaceId", publisher_ns."domain" AS "sourceDomain",
               msg."isDeleted", msg."localState"
        FROM "Message" msg
        INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
        LEFT JOIN "IdentityNamespace" publisher_ns ON publisher_ns."id" = msg."publisherNamespaceId"
        ${profileSubjectIdentityJoins('msg."publisherNamespaceId"', 'msg."profileNamespaceId"', 'creator_ns')}
        WHERE thread."type" = 'GROUP'
        ORDER BY msg."threadId", msg."seq"
      `);
  return {
    groups: groups.rows,
    roster: roster.rows,
    relationships: relationships.rows,
    requests: requests.rows,
    users: users.rows,
    messages: messages.rows,
  };
}

function normalizeNode(node, rows, p2pNode) {
  const groups = new Map(
    rows.groups.map((group) => {
      const address = normalizeAddress(group.account, group.domain);
      return [
        address,
        {
          address,
          account: group.account,
          domain: addressParts(address).domain,
          nodeName: node.name,
          groupId: group.groupId,
          namespaceId: group.namespaceId,
          threadId: group.threadId,
          name: group.name,
          description: group.description,
          avatar: group.avatar,
          defaultProfileRev: group.defaultProfileRev,
          dissolved: group.dissolvedAt !== null,
          roster: [],
          relationships: new Map(),
          requests: [],
          messages: [],
        },
      ];
    }),
  );
  const groupByThread = new Map(
    [...groups.values()].map((group) => [group.threadId, group]),
  );
  for (const member of rows.roster) {
    const group = groupByThread.get(member.threadId);
    if (!group || member.domain === null) continue;
    const address = normalizeAddress(member.account, member.domain);
    group.roster.push({
      address,
      role: member.role,
      profileRev: member.profileRev,
      namespaceId: member.namespaceId,
      profileNamespaceId: member.profileNamespaceId,
      ...addressParts(address),
    });
  }
  for (const row of rows.relationships) {
    const groupOnA = row.endpointAType === 'GROUP';
    const groupAddress = normalizeAddress(
      groupOnA ? row.endpointAAccount : row.endpointBAccount,
      groupOnA ? row.endpointADomain : row.endpointBDomain,
    );
    const memberAddress = normalizeAddress(
      groupOnA ? row.endpointBAccount : row.endpointAAccount,
      groupOnA ? row.endpointBDomain : row.endpointADomain,
    );
    const group = groups.get(groupAddress);
    if (!group) continue;
    const relationship = group.relationships.get(memberAddress) ?? {
      active: row.active,
      groupIntent: null,
      userIntent: null,
    };
    if (row.authorSide) {
      const authorIsGroup = (row.authorSide === 'A') === groupOnA;
      relationship[authorIsGroup ? 'groupIntent' : 'userIntent'] = row.status;
    }
    group.relationships.set(memberAddress, relationship);
  }
  for (const request of rows.requests) {
    const group = groupByThread.get(request.threadId);
    if (!group) continue;
    group.requests.push({
      direction: request.direction,
      feedId: request.feedId,
      memberAccount: request.memberAccount,
      memberDomain: request.memberDomain,
      memberNamespaceId: request.memberNamespaceId ?? 0,
      status: request.status,
      expiresAt: request.expiresAt,
      memberAddress: normalizeAddress(
        request.memberAccount,
        request.memberDomain,
      ),
    });
  }
  for (const message of rows.messages) {
    const group = groupByThread.get(message.threadId);
    if (!group) continue;
    group.messages.push({
      ...message,
      creatorAddress: message.creatorDomain
        ? normalizeAddress(message.creatorAccount, message.creatorDomain)
        : null,
      sourceNamespaceId: message.publisherNamespaceId,
      sourceDomain: message.sourceDomain,
    });
  }
  const users = new Map(
    rows.users.map((user) => {
      const address = normalizeAddress(user.account, user.domain);
      return [address, { id: user.id, address, ...addressParts(address) }];
    }),
  );
  return { node, groups, users, activeP2p: new Set(p2pNode.pairs.active) };
}

export async function readGroupWorkloadSnapshot(connections, p2pSnapshot) {
  const entries = await Promise.all(
    [...connections.values()].map(async ({ node, client }) => [
      node.name,
      normalizeNode(
        node,
        await readNodeGroupRows(client),
        p2pSnapshot[node.name],
      ),
    ]),
  );
  return Object.fromEntries(entries);
}

function roleRank(role) {
  return { MEMBER: 1, ADMIN: 2, OWNER: 3 }[role] ?? 0;
}

function activeRequest(request) {
  return (
    request.status === 'REQUESTED' &&
    new Date(request.expiresAt).getTime() > Date.now()
  );
}

export function observeUserGroup(snapshot, user, plannedGroup) {
  const node = snapshot[user.nodeName];
  if (!node) throw new Error(`group snapshot is missing ${user.nodeName}`);
  const group = node.groups.get(plannedGroup.address);
  const roster = group?.roster ?? [];
  const me = roster.find(({ address }) => address === user.address);
  const relationship = group?.relationships.get(user.address);
  // A mirror can retain its last Group Meta MEMBER_UPSERT after the member's audience
  // is revoked, because that peer can no longer pull the subsequent MEMBER_DEPART.
  // Runtime authorization is the materialized pair fact, so never offer member
  // operations from the historical roster row alone. The OWNER fallback keeps
  // the observation usable for a locally-created group before its pair is read.
  const membershipActive =
    Boolean(me) &&
    (relationship?.active === true ||
      (relationship === undefined && me?.role === 'OWNER'));
  const memberRole = membershipActive ? (me?.role ?? null) : null;
  // Request rows are group-scoped: every OWNER/ADMIN observes (and can act on)
  // all of them — the projection no longer attributes rows to one manager.
  const requests =
    memberRole === 'OWNER' || memberRole === 'ADMIN'
      ? (group?.requests ?? [])
      : [];
  const pendingApplications = requests.filter(
    (request) => request.direction === 'APPLICATION' && activeRequest(request),
  );
  const pendingInvitations = requests.filter(
    (request) => request.direction === 'INVITATION' && activeRequest(request),
  );
  const inviteCandidates = [];
  if (memberRole === 'OWNER' || memberRole === 'ADMIN') {
    for (const candidate of node.users.values()) {
      if (candidate.address === user.address) continue;
      if (roster.some(({ address }) => address === candidate.address)) continue;
      if (!node.activeP2p.has(pairKey(user.address, candidate.address)))
        continue;
      inviteCandidates.push(candidate);
    }
  }
  const lowerMembers = roster.filter(
    (candidate) =>
      candidate.address !== user.address &&
      roleRank(candidate.role) < roleRank(memberRole),
  );
  return {
    kind: 'GROUP',
    user,
    group: {
      ...plannedGroup,
      dissolved: group?.dissolved ?? false,
      threadId: group?.threadId ?? null,
      localGroupId: group?.groupId ?? null,
    },
    memberRole,
    membershipActive,
    groupIntent: relationship?.groupIntent ?? null,
    userIntent: relationship?.userIntent ?? null,
    inviteCandidates,
    pendingApplications,
    pendingInvitations,
    kickCandidates: lowerMembers,
    // Administrator roles can only be granted to members on the group host.
    // Namespace 0 is this node's own home namespace for local members.
    promoteCandidates: roster.filter(
      ({ role, namespaceId }) => role === 'MEMBER' && namespaceId === 0,
    ),
    demoteCandidates: roster.filter(({ role }) => role === 'ADMIN'),
    transferCandidates: roster.filter(
      ({ role, namespaceId }) => role !== 'OWNER' && namespaceId === 0,
    ),
    retractableMessages: (group?.messages ?? [])
      .filter(
        (message) =>
          message.creatorAddress === user.address &&
          message.clientMessageId !== null &&
          message.localState === 'READY' &&
          !message.isDeleted,
      )
      .map(({ seq, clientMessageId }) => ({ seq, clientMessageId })),
    sourceMessages: (group?.messages ?? []).filter(
      (message) =>
        message.contentType === 'PURE_TEXT' &&
        message.localState === 'READY' &&
        !message.isDeleted &&
        Number.isInteger(message.seq),
    ),
    observedOn: node.node.name,
    observedAt: new Date().toISOString(),
  };
}

export function attachCreatedGroups(snapshot, creations) {
  return creations.map((creation) => {
    const node = snapshot[creation.nodeName];
    const group = [...node.groups.values()].find(
      ({ threadId }) => threadId === creation.threadId,
    );
    if (!group)
      throw new Error(
        `${creation.nodeName} did not persist created group thread ${creation.threadId}`,
      );
    return {
      ...creation,
      address: group.address,
      account: group.account,
      domain: group.domain,
    };
  });
}

export function groupHomeNode(address) {
  const { domain } = addressParts(address);
  return federationLabNodeForDomain(domain);
}
