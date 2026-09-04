function action(type, target) {
  return target === undefined ? { type } : { type, target };
}

function categories(entries) {
  return entries.filter(
    (entry) => entry.targets === undefined || entry.targets.length > 0,
  );
}

function pickCategory(random, entries) {
  const available = categories(entries);
  if (available.length === 0) return undefined;
  const selected = random.pick(available);
  return selected.targets
    ? action(selected.type, random.pick(selected.targets))
    : action(selected.type);
}

export function p2pActionOptions(facts) {
  if (facts.state === 'NONE') return [{ type: 'SEND_REQUEST' }];
  if (facts.state === 'FRIEND') return [{ type: 'REVOKE_RELATIONSHIP' }];
  return [
    { type: 'ACCEPT_REQUEST' },
    { type: 'REVERSE_REQUEST' },
    { type: 'REJECT_REQUEST' },
  ];
}

export function chooseP2pAction(facts, random) {
  return random.pick(p2pActionOptions(facts));
}

export function groupIntentActionOptions(facts) {
  if (facts.memberRole) return [];
  if (facts.membershipActive) return [];
  if (facts.groupIntent === 'REQUESTED') {
    return [{ type: 'ACCEPT_GROUP_INVITATION' }];
  }
  if (facts.userIntent === 'REQUESTED') {
    return [{ type: 'REVOKE_GROUP_APPLICATION' }];
  }
  if (facts.group.domain !== facts.user.domain) {
    return [{ type: 'REQUEST_GROUP_JOIN' }];
  }
  return [];
}

export function groupMutationCategories(facts) {
  if (!facts.memberRole) return [];
  const result = [];
  if (facts.memberRole !== 'OWNER') result.push({ type: 'LEAVE_GROUP' });
  if (facts.memberRole === 'MEMBER') return result;
  result.push(
    { type: 'INVITE_GROUP_MEMBER', targets: facts.inviteCandidates },
    { type: 'ACCEPT_GROUP_APPLICATION', targets: facts.pendingApplications },
    { type: 'REJECT_GROUP_APPLICATION', targets: facts.pendingApplications },
    { type: 'REVOKE_GROUP_INVITATION', targets: facts.pendingInvitations },
    { type: 'KICK_GROUP_MEMBER', targets: facts.kickCandidates },
  );
  if (facts.memberRole === 'OWNER') {
    result.push(
      { type: 'SET_GROUP_ADMIN', targets: facts.promoteCandidates },
      { type: 'REMOVE_GROUP_ADMIN', targets: facts.demoteCandidates },
      { type: 'TRANSFER_GROUP_OWNERSHIP', targets: facts.transferCandidates },
    );
  }
  return categories(result);
}

function chooseSend(facts, random) {
  if (random.chance(5)) {
    return {
      type: random.boolean() ? 'SEND_FILE' : 'SEND_GALLERY',
    };
  }
  return { type: 'SEND_GROUP_MESSAGE' };
}

export function chooseGroupAction(facts, random) {
  const intentOptions = groupIntentActionOptions(facts);
  if (!facts.memberRole) {
    return intentOptions.length === 0 ? undefined : random.pick(intentOptions);
  }

  const mutations = groupMutationCategories(facts);
  const chooseMessage = random.chance(90) || mutations.length === 0;
  if (!chooseMessage) return pickCategory(random, mutations);
  if (facts.retractableMessages.length > 0 && random.chance(5)) {
    return action(
      'WITHDRAW_GROUP_MESSAGE',
      random.pick(facts.retractableMessages),
    );
  }
  return chooseSend(facts, random);
}

export function groupDecisionOptions(facts) {
  if (!facts.memberRole) {
    const options = groupIntentActionOptions(facts);
    return options.map(({ type }) => ({ type, weight: 1 / options.length }));
  }
  const mutations = groupMutationCategories(facts);
  const messageWeight = mutations.length > 0 ? 0.9 : 1;
  const withdrawWeight = facts.retractableMessages.length > 0 ? 0.05 : 0;
  const sendWeight = 1 - withdrawWeight;
  return [
    {
      type: 'SEND_GROUP_MESSAGE',
      weight: messageWeight * sendWeight * 0.95,
    },
    {
      type: 'SEND_FILE',
      weight: messageWeight * sendWeight * 0.05 * 0.5,
    },
    {
      type: 'SEND_GALLERY',
      weight: messageWeight * sendWeight * 0.05 * 0.5,
    },
    ...(facts.retractableMessages.length > 0
      ? [
          {
            type: 'WITHDRAW_GROUP_MESSAGE',
            weight: messageWeight * withdrawWeight,
          },
        ]
      : []),
    ...mutations.map(({ type, targets }) => ({
      type,
      weight: 0.1 / mutations.length,
      ...(targets
        ? {
            targetCount: targets.length,
            targets: targets.map(
              (target) =>
                target.address ?? target.memberAddress ?? target.requestId,
            ),
          }
        : {}),
    })),
  ];
}

export function groupUnavailableActions(facts) {
  const unavailable = [];
  if (!facts.memberRole) {
    unavailable.push({
      type: 'SEND_GROUP_MESSAGE',
      reason: 'not a current member',
    });
    if (
      !facts.groupIntent &&
      !facts.userIntent &&
      facts.group.domain === facts.user.domain
    )
      unavailable.push({
        type: 'REQUEST_GROUP_JOIN',
        reason: 'local groups require an invitation',
      });
    return unavailable;
  }
  if (facts.retractableMessages.length === 0)
    unavailable.push({
      type: 'WITHDRAW_GROUP_MESSAGE',
      reason: 'actor has no live authored workload message',
    });
  if (facts.memberRole === 'OWNER')
    unavailable.push({
      type: 'LEAVE_GROUP',
      reason: 'owner must transfer first',
    });
  if (facts.memberRole === 'MEMBER')
    unavailable.push({
      type: 'GROUP_MANAGEMENT',
      reason: 'actor is not an owner or administrator',
    });
  if (facts.memberRole === 'ADMIN') {
    for (const type of [
      'SET_GROUP_ADMIN',
      'REMOVE_GROUP_ADMIN',
      'TRANSFER_GROUP_OWNERSHIP',
    ])
      unavailable.push({ type, reason: 'owner role is required' });
  }
  const managerTargets = [
    ['INVITE_GROUP_MEMBER', facts.inviteCandidates],
    ['ACCEPT_GROUP_APPLICATION', facts.pendingApplications],
    ['REJECT_GROUP_APPLICATION', facts.pendingApplications],
    ['REVOKE_GROUP_INVITATION', facts.pendingInvitations],
    ['KICK_GROUP_MEMBER', facts.kickCandidates],
  ];
  const ownerTargets = [
    ['SET_GROUP_ADMIN', facts.promoteCandidates],
    ['REMOVE_GROUP_ADMIN', facts.demoteCandidates],
    ['TRANSFER_GROUP_OWNERSHIP', facts.transferCandidates],
  ];
  const targets = [
    ...(facts.memberRole === 'OWNER' || facts.memberRole === 'ADMIN'
      ? managerTargets
      : []),
    ...(facts.memberRole === 'OWNER' ? ownerTargets : []),
  ];
  for (const [type, candidates] of targets) {
    if (candidates.length === 0)
      unavailable.push({
        type,
        reason: 'no eligible target in the observed roster/intents',
      });
  }
  return unavailable;
}
