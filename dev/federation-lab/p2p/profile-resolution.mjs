import { federationLabNodes } from '../topology.mjs';
import { openProfileEvents } from './profile-events.mjs';

function homeNode(address) {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const node = federationLabNodes.find(
    (candidate) => candidate.domain === domain,
  );
  if (!node) throw new Error(`no federation lab node owns ${address}`);
  return node;
}

function storedDomain(node, address) {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain === node.domain ? 'local' : domain;
}

function sameProfileKey(left, right) {
  return (
    left?.namespaceId === right?.namespaceId &&
    left?.account === right?.account &&
    left?.domain === right?.domain &&
    left?.rev === right?.rev
  );
}

export async function resolveUntilReady(
  actor,
  selector,
  expectedRev,
  timeoutMs,
  events,
) {
  const deadline = Date.now() + timeoutMs;
  let result = await actor.resolveProfile(selector);
  while (result?.status === 'PENDING' && result.key) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(
        `${actor.address}: timed out resolving profile ${JSON.stringify(selector)}`,
      );
    let terminal;
    try {
      terminal = await events.wait(remaining);
    } catch (cause) {
      throw new Error(
        `${actor.address}: profile resolution ${JSON.stringify(selector)}: ${cause.message}`,
        { cause },
      );
    }
    if (
      terminal.event === 'PROFILE_UNAVAILABLE' &&
      sameProfileKey(terminal.key, result.key)
    ) {
      throw new Error(
        `${actor.address}: profile resolution failed ${JSON.stringify(selector)} key=${JSON.stringify(terminal.key)} reason=${terminal.reason}`,
      );
    }
    result = await actor.resolveProfile(selector);
  }
  if (result?.status === 'READY') {
    if (result.profile?.rev !== expectedRev) {
      throw new Error(
        `${actor.address}: profile selector ${JSON.stringify(selector)} returned rev ${result.profile?.rev}, expected ${expectedRev}`,
      );
    }
    return result.profile;
  }
  throw new Error(
    `${actor.address}: invalid profile resolution result ${JSON.stringify(result)}`,
  );
}

/** Exercise the same lazy exact-profile selectors used by clients before the read-only Oracle runs. */
export async function resolveWorkloadProfiles({
  actors,
  groups,
  profiles,
  p2p,
  p2pMessages,
  log,
  timeoutMs,
  onProgress = console.log,
}) {
  const requests = new Map();
  const add = (
    nodeName,
    actorAddress,
    selector,
    expectedRev,
    kind,
    subject,
  ) => {
    if (!Number.isInteger(expectedRev) || expectedRev < 1) return;
    const key = `${nodeName}|${JSON.stringify(selector)}`;
    if (!requests.has(key))
      requests.set(key, {
        nodeName,
        actorAddress,
        selector,
        expectedRev,
        kind,
        subject,
      });
  };

  for (const planned of log.groups) {
    const originNode = homeNode(planned.address);
    const canonical = groups[originNode.name].groups.get(planned.address);
    if (!canonical || canonical.dissolved) continue;
    const membersByNode = new Map();
    for (const member of canonical.roster) {
      const node = homeNode(member.address);
      if (!membersByNode.has(node.name)) membersByNode.set(node.name, []);
      membersByNode.get(node.name).push(member);
    }
    if (!membersByNode.has(originNode.name)) {
      const owner = canonical.roster.find(({ role }) => role === 'OWNER');
      if (owner) membersByNode.set(originNode.name, [owner]);
    }
    for (const [nodeName, localMembers] of membersByNode) {
      const projection = groups[nodeName].groups.get(planned.address);
      if (!projection) continue;
      const viewer = localMembers[0].address;
      if (nodeName !== originNode.name) {
        add(
          nodeName,
          viewer,
          {
            type: 'GROUP_META',
            threadId: projection.threadId,
            profileRev: projection.defaultProfileRev,
            subject: { type: 'GROUP' },
          },
          projection.defaultProfileRev,
          'GROUP_THREAD_CURRENT',
          planned.address,
        );
      }
      for (const message of projection.messages) {
        if (
          message.localState !== 'READY' ||
          message.isDeleted ||
          !Number.isInteger(message.profileRev) ||
          message.profileRev < 1
        )
          continue;
        add(
          nodeName,
          viewer,
          {
            type: 'MESSAGE_AUTHOR',
            threadId: projection.threadId,
            messageSeq: message.seq,
            rev: message.profileRev,
          },
          message.profileRev,
          'MESSAGE_AUTHOR_HISTORY',
          message.clientMessageId,
        );
      }
      for (const member of projection.roster) {
        // Roster facts and messages can reference different exact revisions.
        // Resolving message authors does not resolve the roster snapshot.
        add(
          nodeName,
          viewer,
          {
            type: 'GROUP_META',
            threadId: projection.threadId,
            profileRev: member.profileRev,
            subject: {
              type: 'MEMBER',
              account: member.account,
              domain: storedDomain(
                federationLabNodes.find(({ name }) => name === nodeName),
                member.address,
              ),
            },
          },
          member.profileRev,
          'GROUP_MEMBER_CURRENT',
          member.address,
        );
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
      ) {
        viewer = reference.subjectAddress;
      } else if (reference.subjectType === 'GROUP') {
        viewer = groups[node.name].groups
          .get(reference.subjectAddress)
          ?.roster.find(
            ({ role, address }) =>
              role === 'OWNER' && homeNode(address).name === node.name,
          )?.address;
      }
      if (!viewer) continue;
      const separator = reference.address.lastIndexOf('@');
      add(
        node.name,
        viewer,
        {
          type: 'EXACT',
          account: reference.address.slice(0, separator),
          domain: reference.address.slice(separator + 1),
          rev: reference.profileRev,
        },
        reference.profileRev,
        'RELATIONSHIP_CURRENT',
        reference.address,
      );
    }
  }

  for (const node of federationLabNodes) {
    for (const pair of p2p?.[node.name]?.pairs.active ?? []) {
      const viewer = pair
        .split('|')
        .find((address) => homeNode(address).name === node.name);
      const thread = p2pMessages?.[node.name]?.get(pair);
      if (!viewer || !thread) continue;
      for (const message of thread.messages) {
        if (message.localState === 'READY' && !message.isDeleted)
          add(
            node.name,
            viewer,
            {
              type: 'MESSAGE_AUTHOR',
              threadId: thread.threadId,
              messageSeq: message.seq,
              rev: message.profileRev,
            },
            message.profileRev,
            'P2P_MESSAGE_AUTHOR',
            pair,
          );
      }
    }
  }
  const checks = [];
  let completed = 0;
  const streams = new Map();
  try {
    for (const request of requests.values()) {
      const actor = actors.user(request.actorAddress);
      if (!streams.has(actor.address))
        streams.set(actor.address, await openProfileEvents(actor, timeoutMs));
      const profile = await resolveUntilReady(
        actor,
        request.selector,
        request.expectedRev,
        timeoutMs,
        streams.get(actor.address),
      );
      checks.push({ ...request, profile });
      completed += 1;
      if (completed === requests.size || completed % 25 === 0)
        onProgress(
          `[profile] resolved ${completed}/${requests.size} referenced profiles`,
        );
    }
    return checks;
  } finally {
    await Promise.all([...streams.values()].map((stream) => stream.close()));
  }
}
