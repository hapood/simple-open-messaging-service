import { pairKey, SeededRandom } from './scenario.mjs';
import { observeDirectedPair } from './operation-log.mjs';
import { readP2pConsistencySnapshot } from './audit.mjs';
import { observeUserGroup, readGroupWorkloadSnapshot } from './group-facts.mjs';
import {
  chooseGroupAction,
  chooseP2pAction,
  groupDecisionOptions,
  groupUnavailableActions,
  p2pActionOptions,
} from './state-machine.mjs';
import { federationLabNodes } from '../topology.mjs';
import { messageOperationTypes } from './message-operations.mjs';
import { admitOperation, journalError } from './operations.mjs';
import { recordMembershipCoverage } from './coverage.mjs';
import {
  groupCandidateWeight,
  weightedOrder,
  workloadPolicy,
} from './workload-policy.mjs';
import {
  executeReferenceWithdrawalScenario,
  planMidpointDissolution,
} from './fixed-scenarios.mjs';
import { randomUUID } from 'node:crypto';
import { readFederationAuditSnapshot } from './final-audit.mjs';
import { executeIdentityTransitionCheckpoint } from './identity-transition.mjs';
import { LabApiError } from './api-actors.mjs';
import { mapConcurrent, waitForTaskQueueIdle } from './execute.mjs';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shuffle(values, random) {
  values = [...values];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const other = random.integer(index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function operationId(index) {
  return `op-${String(index + 1).padStart(6, '0')}`;
}

export function scheduledAdmissionAt(startedAt, index, operationsPerSecond) {
  if (!Number.isInteger(operationsPerSecond) || operationsPerSecond <= 0)
    throw new Error('operationsPerSecond must be a positive integer');
  return startedAt + Math.floor((index * 1_000) / operationsPerSecond);
}

export function createAdmissionPacer(
  operationsPerSecond,
  now = Date.now,
  wait = sleep,
) {
  scheduledAdmissionAt(0, 0, operationsPerSecond);
  let nextAt = 0;
  return async () => {
    const current = now();
    const scheduledAt = Math.max(current, nextAt);
    nextAt = scheduledAt + 1000 / operationsPerSecond;
    if (scheduledAt > current) await wait(scheduledAt - current);
  };
}

function userRef(address) {
  const separator = address.lastIndexOf('@');
  const domain = address.slice(separator + 1);
  const node = federationLabNodes.find(
    (candidate) => candidate.domain === domain,
  );
  if (!node) throw new Error(`no federation lab node owns ${address}`);
  return {
    address,
    account: address.slice(0, separator),
    domain,
    nodeName: node.name,
  };
}

export function chooseStateWindow(log, random, groupSnapshot) {
  const users = shuffle(log.users, random).slice(
    0,
    Math.min(3, log.users.length),
  );
  const shuffledGroups = weightedOrder(random, log.groups ?? [], (group) =>
    group.active ? workloadPolicy.activeGroupWeight : 1,
  );
  const statefulGroups = groupSnapshot
    ? shuffledGroups.filter((group) =>
        users.some((address) => {
          const user = userRef(address);
          const projection = groupSnapshot[user.nodeName]?.groups.get(
            group.address,
          );
          const relationship = projection?.relationships.get(address);
          return (
            projection?.roster.some((member) => member.address === address) ||
            Boolean(relationship?.groupIntent || relationship?.userIntent) ||
            (Boolean(projection?.requests.length) &&
              projection?.roster.some(
                ({ address: member, role }) =>
                  member === address && (role === 'OWNER' || role === 'ADMIN'),
              ))
          );
        }),
      )
    : [];
  const firstGroup = statefulGroups[0];
  const groups = [
    ...(firstGroup ? [firstGroup] : []),
    ...shuffledGroups.filter(({ address }) => address !== firstGroup?.address),
  ].slice(0, Math.min(3, shuffledGroups.length));
  return {
    users,
    groups: groups.map(({ address }) => address),
    statefulGroup: firstGroup?.address ?? null,
  };
}

function chooseProfileUpdate({
  log,
  groupSnapshot,
  random,
  usedGroups,
  usedProfiles,
  id,
  round,
}) {
  const targetKind = random.boolean() ? 'USER' : 'GROUP';
  if (targetKind === 'USER') {
    const available = log.users.filter((address) => !usedProfiles.has(address));
    if (available.length === 0) return undefined;
    const address = random.pick(available);
    usedProfiles.add(address);
    return {
      id,
      round,
      type: 'UPDATE_USER_PROFILE',
      actor: address,
      profileTarget: address,
      avatarAction: random.pick(['KEEP', 'SET', 'REMOVE']),
      selection: {
        kind: 'PROFILE',
        weight: 0.05,
        targetKind,
        targetKindWeight: 0.5,
      },
      decisionOptions: ['UPDATE_USER_PROFILE'],
    };
  }
  const available = log.groups.filter(
    ({ address, nodeName }) =>
      !usedGroups.has(address) &&
      !groupSnapshot[nodeName]?.groups.get(address)?.dissolved,
  );
  if (available.length === 0) return undefined;
  const planned = random.pick(available);
  const origin = groupSnapshot[planned.nodeName]?.groups.get(planned.address);
  const owner = origin?.roster.find(({ role }) => role === 'OWNER');
  if (!origin || !owner) return undefined;
  usedGroups.add(planned.address);
  usedProfiles.add(planned.address);
  return {
    id,
    round,
    type: 'UPDATE_GROUP_PROFILE',
    actor: owner.address,
    profileTarget: planned.address,
    group: planned.address,
    groupThreadId: origin.threadId,
    avatarAction: random.pick(['KEEP', 'SET', 'REMOVE']),
    selection: {
      kind: 'PROFILE',
      weight: 0.05,
      targetKind,
      targetKindWeight: 0.5,
    },
    decisionOptions: ['UPDATE_GROUP_PROFILE'],
  };
}

export function chooseRandomRound({
  log,
  snapshot,
  random,
  count,
  groupSnapshot,
  p2pMessages,
  round = 1,
  operationOffset = log.operations.length,
}) {
  const selectionWindow = chooseStateWindow(log, random, groupSnapshot);
  const selectedUsers = selectionWindow.users.map(userRef);
  const selectedGroupAddresses = new Set(selectionWindow.groups);
  const selectedGroups = groupSnapshot
    ? log.groups.filter(({ address }) => selectedGroupAddresses.has(address))
    : [];
  const p2pCandidates = shuffle(
    selectedUsers.flatMap((author) =>
      log.users
        .filter((subject) => subject !== author.address)
        .map((subject) => [author.address, subject]),
    ),
    random,
  );
  const groupCandidates = weightedOrder(
    random,
    selectedUsers.flatMap((user) =>
      selectedGroups.map((group) => {
        const facts = observeUserGroup(groupSnapshot, user, group);
        facts.pendingApplications = unsubmittedGroupRequests(
          facts.pendingApplications,
          group.address,
          log.operations,
        );
        facts.pendingInvitations = unsubmittedGroupRequests(
          facts.pendingInvitations,
          group.address,
          log.operations,
        );
        facts.previouslyLeft = log.operations.some(
          (operation) =>
            operation.group === group.address &&
            operation.actor === user.address &&
            operation.type === 'LEAVE_GROUP' &&
            operation.status === 'SUCCEEDED',
        );
        return { user, group, facts };
      }),
    ),
    ({ facts }) => groupCandidateWeight(facts),
  );
  const decisions = [];
  const usedGroups = new Set();
  const usedP2pPairs = new Set();
  const usedProfiles = new Set();
  let p2pCursor = 0;
  let groupCursor = 0;
  while (
    decisions.length < count &&
    (p2pCursor < p2pCandidates.length || groupCursor < groupCandidates.length)
  ) {
    const id = operationId(operationOffset + decisions.length);
    if (groupSnapshot && random.chance(5)) {
      const profileUpdate = chooseProfileUpdate({
        log,
        groupSnapshot,
        random,
        usedGroups,
        usedProfiles,
        id,
        round,
      });
      if (profileUpdate) {
        decisions.push(profileUpdate);
        continue;
      }
    }
    const preferGroup = groupCandidates.length > 0 && random.boolean();
    if (preferGroup || p2pCursor >= p2pCandidates.length) {
      let selected;
      while (groupCursor < groupCandidates.length) {
        const candidate = groupCandidates[groupCursor];
        groupCursor += 1;
        if (usedGroups.has(candidate.group.address)) continue;
        const selectedAction = chooseGroupAction(candidate.facts, random);
        if (!selectedAction) continue;
        selected = { ...candidate, selectedAction };
        break;
      }
      if (selected) {
        const { user, group } = selected;
        usedGroups.add(group.address);
        decisions.push({
          id,
          round,
          pair: `${user.address}|${group.address}`,
          selectedAuthor: user.address,
          selectedSubject: group.address,
          selectedDirection: `${user.address}->${group.address}`,
          selection: {
            authorKind: 'USER',
            subjectKind: 'GROUP',
            subjectKindWeight: 0.5,
            window: selectionWindow,
          },
          actor: user.address,
          group: group.address,
          groupThreadId: selected.facts.group.threadId,
          observedFacts: selected.facts,
          decisionOptions: groupDecisionOptions(selected.facts),
          unavailableActions: groupUnavailableActions(selected.facts),
          ...selected.selectedAction,
        });
        continue;
      }
    }
    let selectedP2p;
    while (p2pCursor < p2pCandidates.length) {
      const candidate = p2pCandidates[p2pCursor];
      p2pCursor += 1;
      const key = pairKey(candidate[0], candidate[1]);
      if (usedP2pPairs.has(key)) continue;
      usedP2pPairs.add(key);
      selectedP2p = candidate;
      break;
    }
    if (!selectedP2p) continue;
    const [selectedAuthor, selectedSubject] = selectedP2p;
    const observedFacts = observeDirectedPair(
      snapshot,
      selectedAuthor,
      selectedSubject,
    );
    const common = {
      id,
      round,
      pair: pairKey(selectedAuthor, selectedSubject),
      selectedAuthor,
      selectedSubject,
      selectedDirection: `${selectedAuthor}->${selectedSubject}`,
      selection: {
        authorKind: 'USER',
        subjectKind: 'USER',
        subjectKindWeight: 0.5,
        window: selectionWindow,
      },
      observedFacts,
    };
    const selected = chooseP2pAction(observedFacts, random);
    if (!selected) continue;
    const decision = {
      ...common,
      type: selected.type,
      actor: selectedAuthor,
      peer: selectedSubject,
      decisionOptions: p2pActionOptions(observedFacts).map(({ type }) => type),
    };
    if (selected.type === 'SEND_P2P_MESSAGE') {
      decision.p2pPair = decision.pair;
      decision.threadId = observedFacts.threadId;
      const nodeName = userRef(selectedAuthor).nodeName;
      const authored =
        p2pMessages?.[nodeName]
          ?.get(decision.pair)
          ?.messages.filter(
            (message) =>
              message.creatorAccount === userRef(selectedAuthor).account &&
              message.creatorNamespaceId === 0 &&
              message.clientMessageId &&
              !message.isDeleted &&
              message.localState === 'READY',
          ) ?? [];
      if (authored.length && random.chance(5)) {
        decision.type = 'WITHDRAW_P2P_MESSAGE';
        decision.target = random.pick(authored);
      } else if (random.chance(5))
        decision.type = random.pick(['SEND_FILE', 'SEND_GALLERY']);
    }
    if (
      observedFacts.state === 'OUTGOING_PENDING' ||
      observedFacts.state === 'INCOMING_PENDING'
    ) {
      const outgoing = observedFacts.state === 'OUTGOING_PENDING';
      decision.requestAuthor = outgoing ? selectedAuthor : selectedSubject;
      decision.requestSubject = outgoing ? selectedSubject : selectedAuthor;
      // Incoming actions are performed by this observer, never by the other endpoint.
      decision.actor = selectedAuthor;
    }
    decisions.push(decision);
  }
  return decisions;
}

function actionCounts(operations) {
  const counts = {};
  for (const operation of operations) {
    const key = operation.request?.endpoint ?? operation.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}=${count}`)
    .join(' ');
}

// A projection may still show REQUESTED while an earlier management task is
// admitted or completed. Scope deduplication to the request generation so a
// renewed application remains eligible after its projection feed coordinate advances.
export function unsubmittedGroupRequests(requests, group, operations) {
  const managementTypes = new Set([
    'ACCEPT_GROUP_APPLICATION',
    'REJECT_GROUP_APPLICATION',
    'REVOKE_GROUP_INVITATION',
  ]);
  return requests.filter(
    (request) =>
      !operations.some(
        (operation) =>
          operation.group === group &&
          managementTypes.has(operation.type) &&
          ['ADMITTED', 'SUCCEEDED', 'OBSERVED_UNAVAILABLE'].includes(
            operation.status,
          ) &&
          operation.target?.direction === request.direction &&
          operation.target?.memberAddress === request.memberAddress &&
          operation.target?.requestId === request.requestId,
      ),
  );
}

// Request cancellation can win either before admission or during task execution.
// The current acceptance path reports a mirrored REVOKED direction as
// INVITE_NOT_FOUND; the earlier path reported the same observed-state race as
// INVITE_EXPIRED. Rejection retains its existing expired/already-handled cases.
function isUnavailableIncomingRequest(operation, code) {
  const acceptable =
    operation.type === 'ACCEPT_REQUEST'
      ? code === 20010 || code === 20011
      : operation.type === 'REJECT_REQUEST' &&
        (code === 20011 || code === 20013);
  return Boolean(
    !operation.scenario &&
      !operation.group &&
      operation.pair &&
      operation.observedFacts?.state === 'INCOMING_PENDING' &&
      acceptable,
  );
}

export async function finalizeTasks(operations, actors) {
  const byNode = new Map();
  for (const operation of operations) {
    const nodeOperations = byNode.get(operation.taskNode) ?? [];
    nodeOperations.push(operation);
    byNode.set(operation.taskNode, nodeOperations);
  }
  const finalized = [];
  for (const [nodeName, nodeOperations] of byNode) {
    const statuses = await actors
      .node(nodeName)
      .admin.durableTaskStatuses(nodeOperations.map(({ taskId }) => taskId));
    for (const operation of nodeOperations) {
      const task = statuses.get(operation.taskId);
      if (!task)
        throw new Error(
          `${operation.id}: task ${operation.taskId} disappeared`,
        );
      // Cancelling an observed pending request must not become an unfriend command
      // when an acceptance wins the race. Keep the server's rejection as evidence.
      const handledPendingRequest =
        !operation.scenario &&
        !operation.group &&
        operation.pair &&
        operation.type === 'REVOKE_RELATIONSHIP' &&
        operation.observedFacts?.state === 'OUTGOING_PENDING' &&
        task.status === 'REJECTED' &&
        task.resultCode === 20013;
      const unavailableIncomingRequest =
        task.status === 'REJECTED' &&
        isUnavailableIncomingRequest(operation, task.resultCode);
      finalized.push({
        ...operation,
        status:
          handledPendingRequest ||
          unavailableIncomingRequest ||
          (operation.group &&
            task.status === 'REJECTED' &&
            task.resultCode === 40007)
            ? 'OBSERVED_UNAVAILABLE'
            : task.status,
        resultCode: task.resultCode ?? null,
        lastError: task.lastError ?? null,
        finishedAt: task.completedAt ?? new Date().toISOString(),
      });
    }
  }
  return finalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function observeGroupMessageAvailability(snapshot, decision) {
  const actor = userRef(decision.actor);
  const node = snapshot[actor.nodeName];
  const group = node?.groups.get(decision.group);
  return {
    observedOn: actor.nodeName,
    observedAt: new Date().toISOString(),
    group: decision.group,
    actor: decision.actor,
    threadId: group?.threadId ?? null,
    groupDissolved: group?.dissolved ?? null,
    // Missing projections are not evidence that membership was revoked.
    membershipActive: group?.relationships.get(actor.address)?.active ?? null,
  };
}

export async function executeBatch({
  label,
  decisions,
  log,
  actors,
  concurrency,
  timeoutMs,
  progressEvery,
  onProgress,
  onLog,
  totalLabel,
  operationsPerSecond,
  pace = createAdmissionPacer(operationsPerSecond),
  settle = true,
  admit = admitOperation,
  confirmUnavailable = async () => false,
  confirmGroupUnavailable = async () => null,
}) {
  const admissionStarted = Date.now();
  let completed = 0;
  for (const decision of decisions) {
    if (messageOperationTypes.has(decision.type))
      decision.clientMessageId ??= randomUUID();
    log.operations.push({ ...decision, status: 'PLANNED' });
  }
  await onLog(log);
  const admissionResults = await mapConcurrent(
    decisions,
    concurrency,
    async (decision) => {
      await pace();
      let result;
      try {
        result = await admit(decision, actors, timeoutMs);
      } catch (error) {
        let unavailableConfirmation;
        if (
          decision.group &&
          !decision.scenario &&
          messageOperationTypes.has(decision.type) &&
          decision.observedFacts?.membershipActive === true &&
          error instanceof LabApiError &&
          error.details?.code === 40005
        ) {
          try {
            unavailableConfirmation = await confirmGroupUnavailable(decision);
          } catch (confirmationError) {
            unavailableConfirmation = {
              error: journalError(confirmationError),
            };
          }
        }
        const unavailableGroup =
          decision.group &&
          error instanceof LabApiError &&
          (unavailableConfirmation?.groupDissolved === true ||
            unavailableConfirmation?.membershipActive === false ||
            error.details?.code === 40007 ||
            (decision.type === 'REQUEST_GROUP_JOIN' &&
              error.details?.reason === 'NOT_FOUND'));
        const unavailableP2p =
          !decision.group &&
          error instanceof LabApiError &&
          (isUnavailableIncomingRequest(decision, error.details?.code) ||
            (error.details?.code === 20002 &&
              (await confirmUnavailable(decision))));
        result = {
          ...decision,
          status:
            unavailableGroup || unavailableP2p
              ? 'OBSERVED_UNAVAILABLE'
              : 'ADMISSION_FAILED',
          error: journalError(error),
          ...(unavailableConfirmation ? { unavailableConfirmation } : {}),
          ...(error.attempts ? { attempts: error.attempts } : {}),
          finishedAt: new Date().toISOString(),
        };
      }
      completed += 1;
      if (completed === decisions.length || completed % progressEvery === 0) {
        const seconds = Math.max((Date.now() - admissionStarted) / 1000, 0.001);
        onProgress(
          `[p2p][${label}][admit] ${completed}/${decisions.length} ` +
            `${(completed / seconds).toFixed(1)} req/s${totalLabel}`,
        );
      }
      return result;
    },
  );
  const admissions = new Map(
    admissionResults.map((operation) => [operation.id, operation]),
  );
  log.operations = log.operations.map(
    (operation) => admissions.get(operation.id) ?? operation,
  );
  await onLog(log);
  if (!settle) return;
  await settleWorkloadOperations({
    operations: admissionResults,
    log,
    actors,
    label,
    timeoutMs,
    onProgress,
    onLog,
  });
}

export async function settleWorkloadOperations(
  {
    operations,
    log,
    actors,
    label,
    timeoutMs,
    onProgress,
    onLog,
    drain = false,
  },
  { waitForIdle = waitForTaskQueueIdle, finalize = finalizeTasks } = {},
) {
  const admitted = operations.filter(({ status }) => status === 'ADMITTED');
  if (drain || admitted.length > 0) {
    await waitForIdle({
      actors,
      nodeNames: [...actors.nodes.keys()],
      description: `${label} queue`,
      timeoutMs,
      onProgress,
    });
  }
  const finalized = admitted.length > 0 ? await finalize(admitted, actors) : [];
  const replacements = new Map(
    finalized.map((operation) => [operation.id, operation]),
  );
  log.operations = log.operations.map(
    (operation) => replacements.get(operation.id) ?? operation,
  );

  onProgress(`[p2p][${label}][settle] all durable tasks finished`);
  await onLog(log);

  const admissionFailures = operations.filter(
    ({ status }) => status === 'ADMISSION_FAILED',
  );
  if (admissionFailures.length > 0) {
    throw new Error(
      `${admissionFailures.length} operations failed admission: ${admissionFailures
        .map(({ id }) => id)
        .join(', ')}`,
    );
  }
  const unsuccessful = operations
    .map((operation) => replacements.get(operation.id) ?? operation)
    .filter(
      ({ status }) =>
        !['SUCCEEDED', 'OBSERVED_UNAVAILABLE', 'REJECTED'].includes(status),
    );
  if (unsuccessful.length > 0) {
    throw new Error(
      `${unsuccessful.length} operations did not succeed: ${unsuccessful
        .map(({ id, status }) => `${id}=${status}`)
        .join(', ')}`,
    );
  }
}

export async function executeRandomP2pWorkload({
  log,
  actors,
  connections,
  operationCount,
  roundSize,
  concurrency,
  timeoutMs,
  progressEvery = 25,
  operationsPerSecond = 10,
  onProgress = console.log,
  onLog = async () => {},
}) {
  onProgress(
    '[p2p] intermediate convergence checks disabled; final audit remains mandatory',
  );
  const random = new SeededRandom(log.seed);
  const eventRandom = new SeededRandom(log.seed ^ 0x3c6ef372);
  let round = 0;
  let randomOperations = 0;
  let emptyRounds = 0;
  let snapshot;
  let identityTransitionsDone = false;
  const pace = createAdmissionPacer(operationsPerSecond);

  const execute = async (decisions, label, { randomBatch = false } = {}) => {
    const batch = Array.isArray(decisions) ? decisions : [decisions];
    batch.forEach((operation, index) => {
      operation.id = operationId(log.operations.length + index);
      operation.round = round;
    });
    await executeBatch({
      label,
      decisions: batch,
      log,
      actors,
      concurrency,
      timeoutMs,
      progressEvery,
      onProgress,
      onLog,
      totalLabel: '',
      operationsPerSecond,
      pace,
      settle:
        !randomBatch && !batch.every(({ type }) => type === 'DISSOLVE_GROUP'),
      confirmGroupUnavailable: async (decision) => {
        if (!randomBatch) return null;
        const actor = userRef(decision.actor);
        const localConnections = new Map(
          [...connections].filter(([name]) => name === actor.nodeName),
        );
        const current = await readP2pConsistencySnapshot(
          localConnections,
          log.users,
        );
        const groups = await readGroupWorkloadSnapshot(
          localConnections,
          current,
        );
        return observeGroupMessageAvailability(groups, decision);
      },
      confirmUnavailable: async (decision) => {
        if (!randomBatch || !decision.pair) return false;
        const current = await readP2pConsistencySnapshot(
          connections,
          log.users,
        );
        const actor = decision.actor;
        const peer =
          decision.selectedAuthor === actor
            ? decision.selectedSubject
            : decision.selectedAuthor;
        return observeDirectedPair(current, actor, peer).state === 'NONE';
      },
    });
    snapshot = await readFederationAuditSnapshot(connections, log, {
      readMediaBytes: false,
    });
    recordMembershipCoverage(log, snapshot.groups, snapshot.p2p);
    return snapshot;
  };
  const fixedScenario = async () => {
    const ran = await executeReferenceWithdrawalScenario({
      log,
      snapshot,
      actors,
      execute: (operation) => execute(operation, 'reference-withdrawal'),
      refreshSnapshot: () =>
        readFederationAuditSnapshot(connections, log, {
          readMediaBytes: false,
        }),
      timeoutMs,
    });
    if (ran) await onLog(log);
  };
  while (randomOperations < operationCount) {
    // Observe completed commands without waiting or asserting their outcomes.
    // Lifecycle policy (for example rejoining after leaving) needs these facts.
    const pending = log.operations.filter(
      ({ status }) => status === 'ADMITTED',
    );
    if (pending.length) {
      const observedTasks = await finalizeTasks(pending, actors);
      const completed = new Map(
        observedTasks
          .filter(({ status }) =>
            [
              'SUCCEEDED',
              'REJECTED',
              'FAILED',
              'OBSERVED_UNAVAILABLE',
            ].includes(status),
          )
          .map((operation) => [operation.id, operation]),
      );
      log.operations = log.operations.map(
        (operation) => completed.get(operation.id) ?? operation,
      );
    }
    if (
      !identityTransitionsDone &&
      randomOperations >= Math.ceil(operationCount / 2)
    ) {
      await settleWorkloadOperations({
        operations: log.operations,
        log,
        actors,
        label: 'identity-transition checkpoint',
        drain: true,
        timeoutMs,
        onProgress,
        onLog,
      });
      await executeIdentityTransitionCheckpoint({
        actors,
        log,
        timeoutMs,
        onProgress,
        onLog,
      });
      identityTransitionsDone = true;
      snapshot = await readFederationAuditSnapshot(connections, log, {
        readMediaBytes: false,
      });
      recordMembershipCoverage(log, snapshot.groups, snapshot.p2p);
    }

    const observed = await readP2pConsistencySnapshot(connections, log.users);
    const groups = await readGroupWorkloadSnapshot(connections, observed);
    if (round === 0) recordMembershipCoverage(log, groups, observed);
    if (
      randomOperations >= Math.ceil(operationCount / 2) &&
      log.groups.some((group) => group.active)
    ) {
      snapshot = await readFederationAuditSnapshot(connections, log, {
        readMediaBytes: false,
      });
      await fixedScenario();
      await onLog(log);
      if (log.referenceScenario?.status === 'SUCCEEDED') {
        const dissolution = planMidpointDissolution(log, groups, eventRandom);
        if (dissolution) {
          await execute(dissolution, 'midpoint-dissolution');
          continue;
        }
      }
    }
    const count = Math.min(
      roundSize,
      operationCount - randomOperations,
      randomOperations < Math.ceil(operationCount / 2)
        ? Math.ceil(operationCount / 2) - randomOperations
        : operationCount,
    );
    const decisions = chooseRandomRound({
      log,
      snapshot: observed,
      groupSnapshot: groups,
      p2pMessages: snapshot?.p2pMessages,
      random,
      count,
      round: round + 1,
    });
    if (!decisions.length) {
      if (++emptyRounds > 100)
        throw new Error('state selection made no progress for 100 windows');
      continue;
    }
    emptyRounds = 0;
    round += 1;
    for (const decision of decisions) {
      if (
        [
          'SEND_GROUP_MESSAGE',
          'SEND_P2P_MESSAGE',
          'SEND_QUOTE',
          'FORWARD_DIRECT',
          'FORWARD_HISTORY',
        ].includes(decision.type) &&
        random.chance(5)
      )
        decision.retryMode = random.pick(['AFTER_SUCCESS', 'CONCURRENT']);
    }
    onProgress(`[p2p][round ${round}] choices ${actionCounts(decisions)}`);
    await execute(decisions, `round ${round}`, { randomBatch: true });
    randomOperations += decisions.length;
    log.randomOperations = randomOperations;
    onProgress(
      `[p2p][round ${round}][submitted] random=${randomOperations}/${operationCount}`,
    );
    await fixedScenario();
    await onLog(log);
  }
  if (log.groups.some((group) => group.active)) {
    await fixedScenario();
    if (log.referenceScenario?.status !== 'SUCCEEDED')
      throw new Error(
        'coverage incomplete: reference withdrawal requires two active members on different nodes',
      );
    const dissolution = planMidpointDissolution(
      log,
      snapshot.groups,
      eventRandom,
    );
    if (dissolution) await execute(dissolution, 'midpoint-dissolution');
  }
  await settleWorkloadOperations({
    operations: log.operations,
    log,
    actors,
    label: 'final workload',
    // Parent commands may already be observed complete while fanout children remain.
    drain: true,
    timeoutMs,
    onProgress,
    onLog,
  });
}
