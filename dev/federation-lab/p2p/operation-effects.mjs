import { groupHomeNode } from './group-facts.mjs';
import { pairKey } from './scenario.mjs';

// Run after a batch converges and before another batch can supersede these effects.
// The baseline admits at most one mutation per group/pair in a batch.
export function compareOperationEffects(operations, snapshot) {
  const failures = [];
  const require = (condition, operation, effect) => {
    if (!condition)
      failures.push({
        kind: 'OPERATION_EFFECT',
        operationId: operation.id,
        effect,
      });
  };
  for (const operation of operations) {
    if (operation.status !== 'SUCCEEDED') continue;
    if (!operation.group) {
      if (
        ['ACCEPT_REQUEST', 'REVERSE_REQUEST', 'REVOKE_RELATIONSHIP'].includes(
          operation.type,
        )
      ) {
        const author = operation.requestAuthor ?? operation.actor;
        const subject = operation.requestSubject ?? operation.peer;
        const node = groupHomeNode(author);
        const active = snapshot.p2p[node.name].pairs.active.includes(
          pairKey(author, subject),
        );
        require(active ===
          (operation.type !==
            'REVOKE_RELATIONSHIP'), operation, 'friendship active state');
      }
      continue;
    }
    const node = groupHomeNode(operation.group);
    const group = snapshot.groups[node.name].groups.get(operation.group);
    if (!group) {
      require(false, operation, 'group exists');
      continue;
    }
    const target = operation.target?.address ?? operation.target?.memberAddress;
    const member = group.roster.find(({ address }) => address === target);
    if (operation.type === 'SET_GROUP_ADMIN')
      require(member?.role === 'ADMIN', operation, 'target promoted');
    if (operation.type === 'REMOVE_GROUP_ADMIN')
      require(member?.role === 'MEMBER', operation, 'target demoted');
    if (operation.type === 'TRANSFER_GROUP_OWNERSHIP') {
      require(member?.role === 'OWNER', operation, 'target is current owner');
      require(group.roster.find(({ address }) => address === operation.actor)
        ?.role !== 'OWNER', operation, 'previous owner transferred');
    }
    if (['LEAVE_GROUP', 'KICK_GROUP_MEMBER'].includes(operation.type)) {
      const address =
        operation.type === 'LEAVE_GROUP' ? operation.actor : target;
      require(group.relationships.get(address)?.active ===
        false, operation, 'membership deactivated');
    }
    if (
      ['ACCEPT_GROUP_APPLICATION', 'ACCEPT_GROUP_INVITATION'].includes(
        operation.type,
      )
    ) {
      const address =
        operation.type === 'ACCEPT_GROUP_INVITATION' ? operation.actor : target;
      require(group.relationships.get(address)?.active === true &&
        group.roster.some(
          (row) => row.address === address,
        ), operation, 'membership activated');
    }
    if (operation.type === 'DISSOLVE_GROUP')
      require(group.dissolved, operation, 'group dissolved');
    if (operation.type === 'UPDATE_GROUP_PROFILE') {
      require(group.name === operation.request.body.name &&
        group.description ===
          operation.request.body
            .description, operation, 'submitted group profile applied');
    }
  }
  return { passed: failures.length === 0, failures };
}
