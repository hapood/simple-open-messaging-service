import { groupHomeNode, observeUserGroup } from './group-facts.mjs';
import { parseContent } from './message-operations.mjs';
import { authorIdentity } from './message-evidence.mjs';

function findScenarioMessage(snapshot, planned, operation, observer) {
  const messages = Object.fromEntries(
    Object.entries(snapshot.groups).map(([nodeName, value]) => [
      nodeName,
      value.groups,
    ]),
  );
  const node = groupHomeNode(observer.address);
  const index = messages[node.name]
    .get(planned.address)
    .messages.findIndex((row) => {
      const identity = authorIdentity(node, row, messages, planned.address);
      return (
        identity.actor === operation.actor &&
        identity.seq === operation.result.seq
      );
    });
  return index < 0
    ? undefined
    : snapshot.groups[node.name].groups.get(planned.address).messages[index];
}

function userRef(address) {
  const node = groupHomeNode(address);
  return {
    address,
    account: address.slice(0, address.lastIndexOf('@')),
    domain: node.domain,
    nodeName: node.name,
  };
}

export function selectScenarioMembers(log, groups) {
  for (const planned of log.groups.filter((group) => group.active)) {
    const canonical = groups[planned.nodeName]?.groups.get(planned.address);
    if (!canonical || canonical.dissolved) continue;
    // A retained roster MEMBER_UPSERT is not proof of current access on a former member's node.
    const members = canonical.roster
      .map(({ address }) => userRef(address))
      .filter(
        (user) => observeUserGroup(groups, user, planned).membershipActive,
      );
    for (const source of members) {
      const reader = members.find((user) => user.nodeName !== source.nodeName);
      if (reader) return { planned, source, reader };
    }
  }
  return undefined;
}

export function planMidpointDissolution(log, groups, random) {
  if (log.operations.some((operation) => operation.type === 'DISSOLVE_GROUP'))
    return undefined;
  const planned = random.pick(log.groups.filter((group) => group.active));
  const canonical = groups[planned.nodeName]?.groups.get(planned.address);
  if (!canonical || canonical.dissolved)
    throw new Error('active group unexpectedly unavailable before midpoint');
  const owner = canonical.roster.find(({ role }) => role === 'OWNER');
  if (
    !owner ||
    !observeUserGroup(groups, userRef(owner.address), planned).membershipActive
  )
    throw new Error('active group has no authorized current owner');
  return {
    type: 'DISSOLVE_GROUP',
    actor: owner.address,
    group: planned.address,
    groupThreadId: canonical.threadId,
    audienceNodes: [
      ...new Set([
        planned.nodeName,
        ...canonical.roster.map(({ address }) => groupHomeNode(address).name),
      ]),
    ],
    membersBeforeDissolution: canonical.roster.map(({ address }) => address),
    scenario: 'MIDPOINT_DISSOLUTION',
  };
}

/** Wait only for the scenario's own prerequisites/projection, never for a global oracle. */
export async function waitForScenarioSnapshot({
  snapshot,
  refreshSnapshot,
  check,
  timeoutMs = 120_000,
  intervalMs = 200,
}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return { snapshot, value: await check(snapshot) };
    } catch (error) {
      if (!refreshSnapshot) throw error;
      if (Date.now() >= deadline)
        throw new Error(`reference scenario timed out: ${error.message}`, {
          cause: error,
        });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    snapshot = await refreshSnapshot();
  }
}

// Scenario steps use the same admissions and journal as random work.
export async function executeReferenceWithdrawalScenario({
  log,
  snapshot,
  execute,
  actors,
  refreshSnapshot,
  timeoutMs,
}) {
  if (log.referenceScenario?.status === 'SUCCEEDED') return false;
  const selected = selectScenarioMembers(log, snapshot.groups);
  if (!selected) return false;
  const { planned, source, reader } = selected;
  log.referenceScenario = {
    status: 'RUNNING',
    group: planned.address,
    source: source.address,
    reader: reader.address,
  };
  const decision = (user, type, extra = {}) => ({
    type,
    actor: user.address,
    group: planned.address,
    groupThreadId: snapshot.groups[user.nodeName].groups.get(planned.address)
      .threadId,
    scenario: 'REFERENCE_WITHDRAWAL',
    ...extra,
  });
  snapshot = await execute(
    decision(source, 'SEND_GROUP_MESSAGE', { retryMode: 'CONCURRENT' }),
  );
  const sent = log.operations.at(-1);
  const ready = await waitForScenarioSnapshot({
    snapshot,
    refreshSnapshot,
    timeoutMs,
    check: (current) => {
      const target = findScenarioMessage(current, planned, sent, reader);
      if (!target || target.localState !== 'READY')
        throw new Error(
          'scenario source is not yet visible on the remote reader',
        );
      return target;
    },
  });
  snapshot = ready.snapshot;
  const target = ready.value;
  const references = [];
  for (const type of ['SEND_QUOTE', 'FORWARD_DIRECT', 'FORWARD_HISTORY']) {
    snapshot = await execute(
      decision(reader, type, {
        target,
        ...(type === 'SEND_QUOTE' ? { retryMode: 'AFTER_SUCCESS' } : {}),
      }),
    );
    references.push(log.operations.at(-1).id);
  }
  snapshot = await execute(
    decision(source, 'WITHDRAW_GROUP_MESSAGE', {
      target: {
        seq: sent.result.seq,
        clientMessageId: sent.request.body.clientMessageId,
      },
    }),
  );
  const verified = await waitForScenarioSnapshot({
    snapshot,
    refreshSnapshot,
    timeoutMs,
    check: async (snapshot) => {
      const checks = [];
      for (const user of [source, reader]) {
        const projection = snapshot.groups[user.nodeName].groups.get(
          planned.address,
        );
        for (const operationId of references) {
          const operation = log.operations.find(({ id }) => id === operationId);
          const stored = findScenarioMessage(
            snapshot,
            planned,
            operation,
            user,
          );
          if (!stored)
            throw new Error('reference disappeared after source withdrawal');
          const page = await actors.user(user.address).post(
            '/query-messages',
            {
              threadId: projection.threadId,
              before: stored.seq + 1,
              take: 1,
            },
            'read reference after source withdrawal',
          );
          const visible = page.messages?.find(({ seq }) => seq === stored.seq);
          if (!visible || visible.isDeleted)
            throw new Error('reference not visible after source withdrawal');
          const content = parseContent(visible.content);
          if (operation.type === 'SEND_QUOTE') {
            if (
              !content?.quote ||
              Object.keys(content.quote).some(
                (key) => key !== 'seq' && key !== 'status',
              ) ||
              (content.quote.status !== undefined &&
                content.quote.status !== 'NOT_FOUND')
            )
              throw new Error('withdrawn quote still exposes a source preview');
          } else if (operation.type === 'FORWARD_DIRECT') {
            if (content?.text !== sent.expected.text)
              throw new Error('direct forward lost its copied text');
          } else {
            const bundle = await actors
              .user(user.address)
              .forwardBundle(content?.bundleId);
            if (
              bundle.messages?.length !== 1 ||
              parseContent(bundle.messages[0].content)?.text !==
                sent.expected.text
            )
              throw new Error(
                'history forward lost its immutable source snapshot',
              );
          }
          checks.push({
            viewer: user.address,
            operationId,
            status: 'SUCCEEDED',
          });
        }
      }
      return checks;
    },
  });
  const checks = verified.value;
  log.referenceScenario = {
    ...log.referenceScenario,
    status: 'SUCCEEDED',
    sourceOperation: sent.id,
    referenceOperations: references,
    checks,
  };
  return true;
}
