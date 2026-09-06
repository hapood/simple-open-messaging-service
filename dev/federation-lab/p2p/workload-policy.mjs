// Behavioral preferences never grant permission; callers first supply legal candidates.
export const workloadPolicy = Object.freeze({
  activeGroupWeight: 8,
  rejoinWeight: 3,
  activeApplicationAcceptWeight: 12,
  activeDepartureWeight: 0.15,
  pendingApplicationRevokeChance: 5,
  friendshipRevokeChance: 10,
});

export function weightedPick(random, values, weightOf = () => 1) {
  const weights = values.map(weightOf);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (
    !values.length ||
    !(total > 0) ||
    weights.some((w) => !Number.isFinite(w) || w < 0)
  )
    throw new Error(
      'weighted selection requires finite nonnegative weights and a positive total',
    );
  let remaining = random.next() * total;
  for (let index = 0; index < values.length; index += 1) {
    remaining -= weights[index];
    if (remaining < 0) return values[index];
  }
  return values.at(-1);
}

export function weightedOrder(random, values, weightOf) {
  const remaining = [...values];
  const result = [];
  while (remaining.length) {
    const selected = weightedPick(random, remaining, weightOf);
    result.push(selected);
    remaining.splice(remaining.indexOf(selected), 1);
  }
  return result;
}

export function groupActionWeight(facts, type) {
  if (!facts.group.active) return 1;
  if (type === 'ACCEPT_GROUP_APPLICATION')
    return workloadPolicy.activeApplicationAcceptWeight;
  if (
    [
      'LEAVE_GROUP',
      'KICK_GROUP_MEMBER',
      'REJECT_GROUP_APPLICATION',
      'REVOKE_GROUP_INVITATION',
    ].includes(type)
  )
    return workloadPolicy.activeDepartureWeight;
  return 1;
}

export function groupCandidateWeight(facts) {
  let weight = facts.group.active ? workloadPolicy.activeGroupWeight : 1;
  if (!facts.memberRole && facts.group.active && facts.previouslyLeft)
    weight *= workloadPolicy.rejoinWeight;
  if (
    facts.pendingApplications.length &&
    ['OWNER', 'ADMIN'].includes(facts.memberRole)
  )
    weight *= 3;
  return weight;
}
