import { federationLabNodes } from '../topology.mjs';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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

async function resolveUntilReady(actor, selector, expectedRev, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await actor.resolveProfile(selector);
    if (result?.status === 'READY') {
      if (result.profile?.rev !== expectedRev) {
        throw new Error(
          `${actor.address}: profile selector ${JSON.stringify(selector)} returned rev ${result.profile?.rev}, expected ${expectedRev}`,
        );
      }
      return result.profile;
    }
    if (result?.status !== 'PENDING' || typeof result.requestId !== 'string') {
      throw new Error(
        `${actor.address}: invalid profile resolution result ${JSON.stringify(result)}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${actor.address}: timed out resolving profile ${JSON.stringify(selector)}`,
      );
    }
    await sleep(250);
  }
}

/** Exercise the same lazy exact-profile selectors used by clients before the read-only Oracle runs. */
export async function resolveWorkloadProfiles({
  actors,
  groups,
  profiles,
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
    if (!canonical) continue;
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
            account: projection.account,
            domain: projection.domain,
            rev: projection.defaultProfileRev,
          },
          projection.defaultProfileRev,
          'GROUP_THREAD_CURRENT',
          planned.address,
        );
      }
      const latestMessageByMember = new Map();
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
          { threadId: projection.threadId, messageSeq: message.seq },
          message.profileRev,
          'MESSAGE_AUTHOR_HISTORY',
          message.clientMessageId,
        );
        const previous = latestMessageByMember.get(message.creatorAddress);
        if (!previous || message.seq > previous.seq)
          latestMessageByMember.set(message.creatorAddress, message);
      }
      for (const member of projection.roster) {
        const latest = latestMessageByMember.get(member.address);
        if (latest) continue;
        add(
          nodeName,
          viewer,
          {
            threadId: projection.threadId,
            memberAccount: member.account,
            memberDomain: storedDomain(
              federationLabNodes.find(({ name }) => name === nodeName),
              member.address,
            ),
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

  const checks = [];
  let completed = 0;
  for (const request of requests.values()) {
    const profile = await resolveUntilReady(
      actors.user(request.actorAddress),
      request.selector,
      request.expectedRev,
      timeoutMs,
    );
    checks.push({ ...request, profile });
    completed += 1;
    if (completed === requests.size || completed % 25 === 0)
      onProgress(
        `[profile] resolved ${completed}/${requests.size} referenced profiles`,
      );
  }
  return checks;
}
