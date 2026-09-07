import { federationLabNodes } from '../topology.mjs';
import { pairKey } from './scenario.mjs';

function normalizeAddress(node, account, domain) {
  return `${account}@${domain === 'local' ? node.domain : domain}`;
}

function addressParts(address) {
  const separator = address.lastIndexOf('@');
  return {
    account: address.slice(0, separator),
    domain: address.slice(separator + 1),
  };
}

function apiAddress(node, address) {
  const value = addressParts(address);
  return {
    account: value.account,
    domain: value.domain === node.domain ? 'local' : value.domain,
  };
}

async function readNodeGroupRows(client) {
  // node-postgres serializes a client's queries itself. Await them explicitly
  // instead of relying on the deprecated concurrent-query queueing behavior.
  const groups = await client.query(`
        SELECT thread."id" AS "groupId", thread."groupAccount" AS "account",
               thread."groupDomain" AS "domain", thread."authorityNamespaceId" AS "namespaceId",
               COALESCE(profile."displayName", thread."groupAccount") AS "name",
               COALESCE(profile."bio", '') AS "description",
               COALESCE(profile."avatar", '') AS "avatar",
               COALESCE(account."defaultProfileRev", meta."profileRev", 0) AS "defaultProfileRev",
               COALESCE(account."dissolvedAt", thread."groupDissolvedAt") AS "dissolvedAt",
               thread."id" AS "threadId"
        FROM "MessageThread" thread
        LEFT JOIN "GroupAccount" account ON account."id" = thread."groupAccountId"
        LEFT JOIN "GroupMetaProfileFeed" meta ON meta."threadId" = thread."id"
        LEFT JOIN "Profile" profile ON profile."account" = thread."groupAccount"
          AND profile."domain" = thread."groupDomain"
          AND profile."namespaceId" = thread."authorityNamespaceId"
          AND profile."profileRev" = COALESCE(account."defaultProfileRev", meta."profileRev", 0)
        WHERE thread."type" = 'GROUP'
        ORDER BY thread."id"
      `);
  const roster = await client.query(`
        SELECT latest."threadId", latest."account", latest."domain",
               latest."namespaceId", latest."role", latest."profileRev"
        FROM (
          SELECT DISTINCT ON (fact."threadId", fact."memberDomain", fact."memberAccount")
            fact."threadId", fact."memberAccount" AS "account", fact."memberDomain" AS "domain",
            fact."memberNamespaceId" AS "namespaceId", fact."operation",
            fact."body" ->> 'role' AS "role",
            (fact."body" ->> 'profileRev')::integer AS "profileRev",
            fact."feedId"
          FROM "GroupMetaMemberFeed" fact
          ORDER BY fact."threadId", fact."memberDomain", fact."memberAccount", fact."feedId" DESC
        ) latest
        WHERE latest."operation" = 'UPSERT'
      `);
  const relationships = await client.query(`
        SELECT pair."id"::text, pair."active", pair."threadId",
               pair."endpointAType", pair."endpointAAccount", pair."endpointADomain",
               pair."endpointBType", pair."endpointBAccount", pair."endpointBDomain",
               intent."authorSide", intent."status", intent."expiresAt"
        FROM "RelationshipPair" pair
        LEFT JOIN "RelationshipIntent" intent ON intent."pairId" = pair."id"
        WHERE pair."kind" = 'GROUP_MEMBER'
        ORDER BY pair."id", intent."authorSide"
      `);
  const requests = await client.query(`
        SELECT projection."threadId", projection."direction", projection."requestId"::text,
               projection."status", projection."expiresAt",
               manager."account" AS "managerAccount", manager."domain" AS "managerDomain",
               projection."memberAccount", projection."memberDomain"
        FROM "GroupRequestProjection" projection
        INNER JOIN "Account" manager ON manager."id" = projection."managerUserId"
        ORDER BY projection."threadId", projection."requestId"
      `);
  const users = await client.query(`
        SELECT local_account."id", identity."account", identity."domain"
        FROM (
          SELECT "account", "domain" FROM "Account"
          UNION
          SELECT "endpointAAccount", "endpointADomain" FROM "RelationshipPair"
          WHERE "endpointAType" = 'USER'
          UNION
          SELECT "endpointBAccount", "endpointBDomain" FROM "RelationshipPair"
          WHERE "endpointBType" = 'USER'
        ) identity
        LEFT JOIN "Account" local_account ON identity."domain" = 'local'
          AND local_account."account" = identity."account"
        ORDER BY identity."domain", identity."account"
      `);
  const messages = await client.query(`
        SELECT msg."id"::text, msg."threadId", msg."seq", msg."originSeq", msg."profileRev",
               msg."contentType", msg."content", msg."clientMessageId",
               msg."creatorAccount", msg."creatorDomain", msg."creatorNamespaceId", msg."isDeleted", msg."localState"
        FROM "Message" msg
        INNER JOIN "MessageThread" thread ON thread."id" = msg."threadId"
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
      const address = normalizeAddress(node, group.account, group.domain);
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
    if (!group) continue;
    const address = normalizeAddress(node, member.account, member.domain);
    group.roster.push({
      address,
      role: member.role,
      profileRev: member.profileRev,
      namespaceId: member.namespaceId,
      ...apiAddress(node, address),
    });
  }
  for (const row of rows.relationships) {
    const groupOnA = row.endpointAType === 'GROUP';
    const groupAddress = normalizeAddress(
      node,
      groupOnA ? row.endpointAAccount : row.endpointBAccount,
      groupOnA ? row.endpointADomain : row.endpointBDomain,
    );
    const memberAddress = normalizeAddress(
      node,
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
      requestId: request.requestId,
      status: request.status,
      expiresAt: request.expiresAt,
      managerAddress: normalizeAddress(
        node,
        request.managerAccount,
        request.managerDomain,
      ),
      memberAddress: normalizeAddress(
        node,
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
      creatorAddress: normalizeAddress(
        node,
        message.creatorAccount,
        message.creatorDomain,
      ),
    });
  }
  const users = new Map(
    rows.users.map((user) => {
      const address = normalizeAddress(node, user.account, user.domain);
      return [address, { id: user.id, address, ...apiAddress(node, address) }];
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
  // A mirror can retain its last Group Meta UPSERT after the member's audience
  // is revoked, because that peer can no longer pull the subsequent DEPART.
  // Runtime authorization is the materialized pair fact, so never offer member
  // operations from the historical roster row alone. The OWNER fallback keeps
  // the observation usable for a locally-created group before its pair is read.
  const membershipActive =
    Boolean(me) &&
    (relationship?.active === true ||
      (relationship === undefined && me?.role === 'OWNER'));
  const memberRole = membershipActive ? (me?.role ?? null) : null;
  const requests = (group?.requests ?? []).filter(
    ({ managerAddress }) => managerAddress === user.address,
  );
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
    promoteCandidates: roster.filter(
      ({ role, domain }) => role === 'MEMBER' && domain === 'local',
    ),
    demoteCandidates: roster.filter(({ role }) => role === 'ADMIN'),
    transferCandidates: roster.filter(
      ({ role, domain }) => role !== 'OWNER' && domain === 'local',
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
  return federationLabNodes.find((node) => node.domain === domain);
}
