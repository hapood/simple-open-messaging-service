import { parseProfileDemand } from '../../../shared/profile-demand.ts';
import {
  federationLabNodeForDomain,
  federationLabNodes,
} from '../topology.mjs';
import { openProfileEvents } from './profile-events.mjs';

function homeNode(address) {
  return federationLabNodeForDomain(
    address.slice(address.lastIndexOf('@') + 1),
  );
}

function sameProfileKey(left, right) {
  return (
    left?.publisherNamespaceId === right?.publisherNamespaceId &&
    left?.profileNamespaceId === right?.profileNamespaceId &&
    left?.account === right?.account &&
    left?.rev === right?.rev
  );
}

class ProfileUnavailableError extends Error {
  constructor(actor, demand, terminal) {
    super(
      `${actor.address}: profile resolution failed ${JSON.stringify(demand)} key=${JSON.stringify(terminal.key)} reason=${terminal.reason}`,
    );
    this.reason = terminal.reason;
  }
}

export async function resolveUntilReady(
  actor,
  demand,
  expectedRev,
  timeoutMs,
  events,
) {
  const deadline = Date.now() + timeoutMs;
  let result = await actor.resolveProfile(demand);
  while (result?.status === 'PENDING' && result.key) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        `${actor.address}: timed out resolving profile ${JSON.stringify(demand)}`,
      );
    let terminal;
    try {
      terminal = await events.wait(remaining);
    } catch (cause) {
      throw new Error(
        `${actor.address}: profile resolution ${JSON.stringify(demand)}: ${cause.message}`,
        { cause },
      );
    }
    if (!sameProfileKey(terminal.key, result.key)) continue;
    if (terminal.event === 'PROFILE_UNAVAILABLE')
      throw new ProfileUnavailableError(actor, demand, terminal);
    result = await actor.resolveProfile(demand);
  }
  if (result?.status === 'READY') {
    if (result.profile?.rev !== expectedRev)
      throw new Error(
        `${actor.address}: profile demand ${JSON.stringify(demand)} returned rev ${result.profile?.rev}, expected ${expectedRev}`,
      );
    return result.profile;
  }
  throw new Error(
    `${actor.address}: invalid profile resolution result ${JSON.stringify(result)}`,
  );
}

/** Build current client demands from retained publisher-scoped references, never from display domains. */
export function planWorkloadProfileRequests({
  groups,
  profiles,
  p2p,
  p2pMessages,
  log,
}) {
  const requests = new Map();
  const add = (nodeName, actorAddress, value, kind, subject) => {
    if (!Number.isInteger(value.target.rev) || value.target.rev < 1) return;
    const demand = parseProfileDemand(value);
    const key = `${nodeName}|${JSON.stringify(demand)}`;
    if (!requests.has(key))
      requests.set(key, {
        nodeName,
        actorAddress,
        demand,
        expectedRev: demand.target.rev,
        kind,
        subject,
      });
  };
  const accountDemand = (
    publisherNamespaceId,
    profileNamespaceId,
    account,
    rev,
  ) => ({
    publisherNamespaceId,
    lookup: 'ACCOUNT_PROFILE',
    target: { profileNamespaceId, account, rev },
  });
  const memberDemand = (group, profileNamespaceId, account, rev) => ({
    publisherNamespaceId: group.namespaceId,
    lookup: 'GROUP_MEMBER_PROFILE',
    groupAccount: group.account,
    target: { profileNamespaceId, account, rev },
  });
  for (const planned of log.groups) {
    const origin = homeNode(planned.address);
    const canonical = groups[origin.name].groups.get(planned.address);
    if (!canonical || canonical.dissolved) continue;
    const membersByNode = new Map();
    for (const member of canonical.roster) {
      const node = homeNode(member.address);
      if (!membersByNode.has(node.name)) membersByNode.set(node.name, []);
      membersByNode.get(node.name).push(member);
    }
    for (const [nodeName, localMembers] of membersByNode) {
      const projection = groups[nodeName].groups.get(planned.address);
      if (!projection) continue;
      const viewer = localMembers[0].address;
      if (nodeName !== origin.name)
        add(
          nodeName,
          viewer,
          accountDemand(
            projection.namespaceId,
            0,
            projection.account,
            projection.defaultProfileRev,
          ),
          'GROUP_THREAD_CURRENT',
          planned.address,
        );
      for (const message of projection.messages) {
        if (
          message.contentType === 'SYSTEM' ||
          message.localState !== 'READY' ||
          message.isDeleted
        )
          continue;
        const demand =
          projection.namespaceId > 0 &&
          message.publisherNamespaceId === projection.namespaceId
            ? memberDemand(
                projection,
                message.profileNamespaceId,
                message.creatorAccount,
                message.profileRev,
              )
            : accountDemand(
                message.publisherNamespaceId,
                message.profileNamespaceId,
                message.creatorAccount,
                message.profileRev,
              );
        add(
          nodeName,
          viewer,
          demand,
          'MESSAGE_AUTHOR_HISTORY',
          message.clientMessageId,
        );
      }
      for (const member of projection.roster) {
        // Local profiles and a local authority's direct peer snapshots use the
        // account lookup. Foreign group references retain authority coordinates.
        const demand =
          member.namespaceId === 0 || projection.namespaceId === 0
            ? accountDemand(
                member.namespaceId,
                0,
                member.account,
                member.profileRev,
              )
            : memberDemand(
                projection,
                member.profileNamespaceId,
                member.account,
                member.profileRev,
              );
        add(nodeName, viewer, demand, 'GROUP_MEMBER_CURRENT', member.address);
      }
    }
  }
  for (const node of federationLabNodes) {
    for (const reference of profiles[node.name].intentRefs) {
      if (homeNode(reference.address).name === node.name) continue;
      let viewer;
      if (
        reference.subjectType === 'USER' &&
        homeNode(reference.subjectAddress).name === node.name
      )
        viewer = reference.subjectAddress;
      else if (reference.subjectType === 'GROUP')
        viewer = groups[node.name].groups
          .get(reference.subjectAddress)
          ?.roster.find(
            ({ role, address }) =>
              role === 'OWNER' && homeNode(address).name === node.name,
          )?.address;
      if (!viewer) continue;
      const account = reference.address.slice(
        0,
        reference.address.lastIndexOf('@'),
      );
      add(
        node.name,
        viewer,
        accountDemand(
          reference.publisherNamespaceId,
          reference.profileNamespaceId,
          account,
          reference.profileRev,
        ),
        'RELATIONSHIP_CURRENT',
        reference.address,
      );
    }
    for (const pair of p2p?.[node.name]?.pairs.active ?? []) {
      const viewer = pair
        .split('|')
        .find((address) => homeNode(address).name === node.name);
      const thread = p2pMessages?.[node.name]?.get(pair);
      if (!viewer || !thread) continue;
      for (const message of thread.messages)
        if (
          message.contentType !== 'SYSTEM' &&
          message.localState === 'READY' &&
          !message.isDeleted
        )
          add(
            node.name,
            viewer,
            accountDemand(
              message.publisherNamespaceId,
              message.profileNamespaceId,
              message.creatorAccount,
              message.profileRev,
            ),
            'P2P_MESSAGE_AUTHOR',
            pair,
          );
    }
  }
  return [...requests.values()];
}

/** Exercise the current client profile demand API before the final read-only audit. */
export async function resolveWorkloadProfiles({
  actors,
  timeoutMs,
  onProgress = console.log,
  ...snapshot
}) {
  const requests = planWorkloadProfileRequests(snapshot);
  const checks = [];
  const streams = new Map();
  const deferred = [];
  const resolveRequest = async (request) => {
    const actor = actors.user(request.actorAddress);
    if (!streams.has(actor.address))
      streams.set(actor.address, await openProfileEvents(actor, timeoutMs));
    const profile = await resolveUntilReady(
      actor,
      request.demand,
      request.expectedRev,
      timeoutMs,
      streams.get(actor.address),
    );
    checks.push({ ...request, profile });
    if (checks.length === requests.length || checks.length % 25 === 0)
      onProgress(
        `[profile] resolved ${checks.length}/${requests.length} referenced profiles`,
      );
  };
  try {
    for (const request of requests) {
      try {
        await resolveRequest(request);
      } catch (error) {
        const foreignGroupProfile =
          request.demand.publisherNamespaceId > 0 &&
          (request.demand.lookup === 'GROUP_MEMBER_PROFILE' ||
            request.kind === 'GROUP_THREAD_CURRENT');
        if (
          !foreignGroupProfile ||
          !(error instanceof ProfileUnavailableError) ||
          error.reason !== 'NOT_FOUND'
        )
          throw error;
        deferred.push(request);
      }
    }
    if (deferred.length)
      onProgress(
        `[profile] retrying ${deferred.length} non-authoritative group profile demands once after the first client pass`,
      );
    for (const request of deferred) await resolveRequest(request);
    return checks;
  } finally {
    await Promise.all([...streams.values()].map((stream) => stream.close()));
  }
}
