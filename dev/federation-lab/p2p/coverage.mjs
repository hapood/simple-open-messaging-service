// Track transitions only at converged checkpoints, never from transient mirrored rosters.
export function recordMembershipCoverage(log, groups, p2p) {
  if (p2p) {
    log.friendshipCoverage ??= {};
    const active = new Set(
      Object.values(p2p).flatMap(({ pairs }) => pairs.active),
    );
    for (const pair of new Set([
      ...Object.keys(log.friendshipCoverage),
      ...active,
    ])) {
      const previous = log.friendshipCoverage[pair] ?? {
        active: false,
        activations: 0,
        removals: 0,
      };
      if (active.has(pair) && !previous.active) previous.activations += 1;
      if (!active.has(pair) && previous.active) previous.removals += 1;
      previous.active = active.has(pair);
      log.friendshipCoverage[pair] = previous;
    }
  }
  log.membershipCoverage ??= {};
  for (const planned of log.groups) {
    const group = groups[planned.nodeName]?.groups.get(planned.address);
    if (!group) continue;
    for (const member of log.users) {
      const key = `${planned.address}|${member}`;
      const row = group.roster.find(({ address }) => address === member);
      const relation = group.relationships.get(member);
      const active =
        !group.dissolved &&
        Boolean(row) &&
        (relation?.active === true || (!relation && row.role === 'OWNER'));
      const previous = log.membershipCoverage[key] ?? {
        active: false,
        joins: 0,
        departures: 0,
      };
      if (active && !previous.active) previous.joins += 1;
      if (!active && previous.active && !group.dissolved)
        previous.departures += 1;
      previous.active = active;
      log.membershipCoverage[key] = previous;
    }
  }
}

export function summarizeCoverage(log) {
  const operations = log.operations.filter(
    ({ status }) => status === 'SUCCEEDED',
  );
  const byType = {};
  for (const { type } of operations) byType[type] = (byType[type] ?? 0) + 1;
  return {
    randomOperations: log.randomOperations ?? 0,
    logicalOperations: log.operations.length,
    byType,
    activeGroups: log.groups
      .filter(({ active }) => active)
      .map(({ address }) => address),
    rejoins: Object.values(log.membershipCoverage ?? {}).reduce(
      (sum, entry) => sum + Math.max(0, entry.joins - 1),
      0,
    ),
    departures: Object.values(log.membershipCoverage ?? {}).reduce(
      (sum, entry) => sum + entry.departures,
      0,
    ),
    idempotentSends: operations.filter(({ attempts }) => attempts?.length > 1)
      .length,
    reestablishedFriendships: Object.values(
      log.friendshipCoverage ?? {},
    ).reduce((sum, entry) => sum + Math.max(0, entry.activations - 1), 0),
    referenceWithdrawal: log.referenceScenario ?? { status: 'NOT_COVERED' },
    observedUnavailable: log.operations.filter(
      ({ status }) => status === 'OBSERVED_UNAVAILABLE',
    ).length,
  };
}
