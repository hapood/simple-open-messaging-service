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
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { waitForFederationConvergence } from './final-audit.mjs';
import { LabApiError } from './api-actors.mjs';
import {
  mapConcurrent,
  resolveWithRetry,
  waitForIncoming,
  waitForTaskQueueIdle,
} from './execute.mjs';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shuffle(values, random) {
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
  const shuffledGroups = shuffle(log.groups ?? [], random);
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
            projection?.requests.some(
              (request) => request.managerAddress === address,
            )
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
    ({ address }) => !usedGroups.has(address),
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
  const groupCandidates = shuffle(
    selectedUsers.flatMap((user) =>
      selectedGroups.map((group) => {
        const facts = observeUserGroup(groupSnapshot, user, group);
        const managerHasWork =
          (facts.memberRole === 'OWNER' || facts.memberRole === 'ADMIN') &&
          (facts.pendingApplications.length > 0 ||
            facts.pendingInvitations.length > 0);
        const priority = managerHasWork
          ? 4
          : facts.memberRole
            ? 3
            : facts.groupIntent || facts.userIntent
              ? 2
              : 1;
        return { user, group, facts, priority };
      }),
    ),
    random,
  ).sort((left, right) => right.priority - left.priority);
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
    const decision = {
      ...common,
      type: selected.type,
      actor: selectedAuthor,
      peer: selectedSubject,
      decisionOptions: p2pActionOptions(observedFacts).map(({ type }) => type),
    };
    if (
      observedFacts.state === 'OUTGOING_PENDING' ||
      observedFacts.state === 'INCOMING_PENDING'
    ) {
      const outgoing = observedFacts.state === 'OUTGOING_PENDING';
      decision.requestAuthor = outgoing ? selectedAuthor : selectedSubject;
      decision.requestSubject = outgoing ? selectedSubject : selectedAuthor;
      decision.actor = decision.requestSubject;
    }
    decisions.push(decision);
  }
  return decisions;
}

function relationshipAddress(actor, peer) {
  return {
    account: peer.account,
    domain: actor.node.name === peer.node.name ? 'local' : peer.domain,
  };
}

function journalBody(body) {
  return body.avatar ? { ...body, avatar: '[present]' } : body;
}

function journalError(error) {
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(password|token|cookie|otp)$/i.test(key) ? '[redacted]' : redact(item),
      ]),
    );
  };
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof LabApiError ? { details: redact(error.details) } : {}),
  };
}

async function sendRequest(actor, peer, timeoutMs) {
  let resolved;
  const body = relationshipAddress(actor, peer);
  if (actor.node.name !== peer.node.name) {
    resolved = await resolveWithRetry(actor, peer, timeoutMs);
    body.displayName = resolved.user.name;
    if (resolved.user.avatar) body.avatar = resolved.user.avatar;
  }
  const accepted = await actor.post(
    '/relationship/request',
    body,
    `request relationship with ${peer.address}`,
  );
  return {
    accepted,
    actor,
    request: {
      method: 'POST',
      endpoint: '/relationship/request',
      body: journalBody(body),
    },
    ...(resolved
      ? {
          preflight: {
            endpoint: '/user/resolve-federated-stream',
            target: peer.address,
            observedRelationship: resolved.relationship ?? null,
          },
        }
      : {}),
  };
}

async function admitProfileOperation(operation, actors) {
  const actor = actors.user(operation.actor);
  if (operation.type === 'UPDATE_USER_PROFILE') {
    const body = {
      name: `user-${operation.id}`,
      bio: `Federation profile update ${operation.id}`,
      avatar: operation.avatarAction,
    };
    await actor.updateProfile(body);
    return {
      actor,
      request: {
        method: 'POST',
        endpoint: '/user/update-profile',
        body,
      },
    };
  }
  if (operation.type === 'UPDATE_GROUP_PROFILE') {
    const avatar =
      operation.avatarAction === 'SET'
        ? await actor.uploadAvatar()
        : operation.avatarAction === 'REMOVE'
          ? ''
          : undefined;
    const body = {
      groupId: operation.groupThreadId,
      name: `group-${operation.id}`,
      description: `Federation group update ${operation.id}`,
      ...(avatar !== undefined ? { avatar } : {}),
    };
    await actor.updateGroup(body);
    return {
      actor,
      request: {
        method: 'POST',
        endpoint: '/group/update',
        body: journalBody(body),
      },
    };
  }
  throw new Error(`unsupported profile operation ${operation.type}`);
}

function groupAddress(actor, address) {
  const separator = address.lastIndexOf('@');
  const domain = address.slice(separator + 1);
  return {
    account: address.slice(0, separator),
    domain: domain === actor.domain ? 'local' : domain,
  };
}

async function admitGroupOperation(operation, actors, timeoutMs) {
  const actor = actors.user(operation.actor);
  const address = groupAddress(actor, operation.group);
  const threadId = operation.groupThreadId;
  let endpoint;
  let body;
  let accepted;
  let preflight;
  if (operation.type === 'REQUEST_GROUP_JOIN') {
    endpoint = '/relationship/request';
    let displayName = operation.observedFacts.group.name;
    if (address.domain !== 'local') {
      const resolved = await resolveWithRetry(
        actor,
        operation.observedFacts.group,
        timeoutMs,
      );
      displayName = resolved.user.name;
      preflight = {
        endpoint: '/user/resolve-federated-stream',
        target: operation.group,
        observedRelationship: resolved.relationship ?? null,
      };
    }
    body = {
      ...address,
      note: operation.id,
      displayName,
    };
    accepted = await actor.post(
      endpoint,
      body,
      `request to join ${operation.group}`,
    );
  } else if (operation.type === 'ACCEPT_GROUP_INVITATION') {
    endpoint = '/relationship/accept';
    body = address;
    accepted = await actor.post(
      endpoint,
      body,
      `accept invitation to ${operation.group}`,
    );
  } else if (operation.type === 'REVOKE_GROUP_APPLICATION') {
    endpoint = '/relationship/revoke';
    body = address;
    accepted = await actor.post(
      endpoint,
      body,
      `revoke group intent for ${operation.group}`,
    );
  } else if (operation.type === 'LEAVE_GROUP') {
    endpoint = '/group/leave';
    body = { groupId: threadId };
    accepted = await actor.post(endpoint, body, `leave ${operation.group}`);
  } else if (operation.type === 'INVITE_GROUP_MEMBER') {
    endpoint = '/group/invite';
    body = { groupId: threadId, userIds: [operation.target.id] };
    const result = await actor.post(
      endpoint,
      body,
      `invite ${operation.target.address}`,
    );
    if (result.tasks?.length !== 1 || result.skipped?.length !== 0) {
      throw new Error(
        `${operation.id}: group invite was not admitted: ${JSON.stringify(result)}`,
      );
    }
    accepted = result.tasks[0];
  } else if (
    operation.type === 'ACCEPT_GROUP_APPLICATION' ||
    operation.type === 'REJECT_GROUP_APPLICATION' ||
    operation.type === 'REVOKE_GROUP_INVITATION'
  ) {
    endpoint = {
      ACCEPT_GROUP_APPLICATION: '/group/join-request/accept',
      REJECT_GROUP_APPLICATION: '/group/join-request/reject',
      REVOKE_GROUP_INVITATION: '/group/invitation/revoke',
    }[operation.type];
    body = { groupId: threadId, requestId: operation.target.requestId };
    accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} in ${operation.group}`,
    );
  } else if (
    operation.type === 'KICK_GROUP_MEMBER' ||
    operation.type === 'TRANSFER_GROUP_OWNERSHIP' ||
    operation.type === 'SET_GROUP_ADMIN' ||
    operation.type === 'REMOVE_GROUP_ADMIN'
  ) {
    endpoint = {
      KICK_GROUP_MEMBER: '/group/kick',
      TRANSFER_GROUP_OWNERSHIP: '/group/transfer',
      SET_GROUP_ADMIN: '/group/set-role',
      REMOVE_GROUP_ADMIN: '/group/set-role',
    }[operation.type];
    body = {
      groupId: threadId,
      account: operation.target.account,
      domain: operation.target.domain,
      ...(operation.type === 'SET_GROUP_ADMIN'
        ? { role: 'ADMIN' }
        : operation.type === 'REMOVE_GROUP_ADMIN'
          ? { role: 'MEMBER' }
          : {}),
    };
    accepted = await actor.post(
      endpoint,
      body,
      `${operation.type} in ${operation.group}`,
    );
  } else if (operation.type === 'SEND_GROUP_MESSAGE') {
    endpoint = '/send-message';
    const clientMessageId = randomUUID();
    body = {
      threadId,
      clientMessageId,
      text: `federation-lab ${operation.id}`,
    };
    const message = await actor.sendText(threadId, body.text, clientMessageId);
    return { actor, request: { method: 'POST', endpoint, body }, message };
  } else if (
    operation.type === 'SEND_FILE' ||
    operation.type === 'SEND_GALLERY'
  ) {
    endpoint = '/send-media + /upload';
    const clientMessageId = randomUUID();
    const count = operation.type === 'SEND_FILE' ? 1 : 2;
    const parts = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const serial = Number(operation.id.replace(/\D/g, '')) + index;
        return {
          partId: randomUUID(),
          filename: `${operation.id}-${index + 1}.png`,
          mimeType: 'image/png',
          bytes: await sharp({
            create: {
              width: 1,
              height: 1,
              channels: 4,
              background: {
                r: serial % 256,
                g: (serial * 37) % 256,
                b: (serial * 83) % 256,
                alpha: 1,
              },
            },
          })
            .png()
            .toBuffer(),
        };
      }),
    );
    const message = await actor.sendMedia({ threadId, clientMessageId, parts });
    body = { threadId, clientMessageId, fileCnt: count };
    return { actor, request: { method: 'POST', endpoint, body }, message };
  } else if (operation.type === 'WITHDRAW_GROUP_MESSAGE') {
    endpoint = '/withdraw-message';
    body = { threadId, seq: operation.target.seq };
    const message = await actor.withdrawMessage(threadId, operation.target.seq);
    return {
      actor,
      request: { method: 'POST', endpoint, body },
      message,
      withdrawnClientMessageId: operation.target.clientMessageId,
    };
  } else {
    throw new Error(`unsupported group operation ${operation.type}`);
  }
  return {
    accepted,
    actor,
    request: { method: 'POST', endpoint, body: journalBody(body) },
    ...(preflight ? { preflight } : {}),
  };
}

export async function admitOperation(operation, actors, timeoutMs) {
  let admission;
  if (
    operation.type === 'UPDATE_USER_PROFILE' ||
    operation.type === 'UPDATE_GROUP_PROFILE'
  ) {
    admission = await admitProfileOperation(operation, actors);
  } else if (operation.group) {
    admission = await admitGroupOperation(operation, actors, timeoutMs);
  } else if (operation.type === 'SEND_REQUEST') {
    admission = await sendRequest(
      actors.user(operation.actor),
      actors.user(operation.peer),
      timeoutMs,
    );
  } else if (operation.type === 'REVERSE_REQUEST') {
    admission = await sendRequest(
      actors.user(operation.requestSubject),
      actors.user(operation.requestAuthor),
      timeoutMs,
    );
  } else if (
    operation.type === 'ACCEPT_REQUEST' ||
    operation.type === 'REJECT_REQUEST'
  ) {
    const actor = actors.user(operation.requestSubject);
    const initiator = actors.user(operation.requestAuthor);
    await waitForIncoming(actor, initiator, timeoutMs);
    const endpoint =
      operation.type === 'ACCEPT_REQUEST'
        ? '/relationship/accept'
        : '/relationship/revoke';
    const body = relationshipAddress(actor, initiator);
    const accepted = await actor.post(
      endpoint,
      body,
      `${operation.type === 'ACCEPT_REQUEST' ? 'accept' : 'reject'} relationship request from ${initiator.address}`,
    );
    admission = {
      accepted,
      actor,
      request: { method: 'POST', endpoint, body: journalBody(body) },
    };
  } else if (operation.type === 'REVOKE_RELATIONSHIP') {
    const actor = actors.user(operation.actor);
    const peer = actors.user(operation.peer);
    const body = relationshipAddress(actor, peer);
    const accepted = await actor.post(
      '/relationship/revoke',
      body,
      `revoke relationship with ${peer.address}`,
    );
    admission = {
      accepted,
      actor,
      request: {
        method: 'POST',
        endpoint: '/relationship/revoke',
        body: journalBody(body),
      },
    };
  } else {
    throw new Error(`unsupported random operation ${operation.type}`);
  }
  const taskId = admission.accepted?.taskId;
  if (taskId !== undefined && typeof taskId !== 'string')
    throw new Error(
      `${operation.id}: admission returned an invalid durable task id`,
    );
  return {
    ...operation,
    actor: admission.actor.address,
    request: admission.request,
    ...(admission.preflight ? { preflight: admission.preflight } : {}),
    ...(admission.message ? { result: admission.message } : {}),
    ...(admission.withdrawnClientMessageId
      ? { withdrawnClientMessageId: admission.withdrawnClientMessageId }
      : {}),
    ...(taskId ? { taskId, taskNode: admission.actor.node.name } : {}),
    status: taskId ? 'ADMITTED' : 'SUCCEEDED',
    admittedAt: new Date().toISOString(),
  };
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

async function finalizeTasks(operations, actors) {
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
      finalized.push({
        ...operation,
        status: task.status,
        resultCode: task.resultCode ?? null,
        lastError: task.lastError ?? null,
        finishedAt: task.completedAt ?? new Date().toISOString(),
      });
    }
  }
  return finalized.sort((left, right) => left.id.localeCompare(right.id));
}

async function executeBatch({
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
}) {
  const admissionStarted = Date.now();
  let completed = 0;
  const admissionResults = await mapConcurrent(
    decisions,
    concurrency,
    async (decision, index) => {
      const scheduledAt = scheduledAdmissionAt(
        admissionStarted,
        index,
        operationsPerSecond,
      );
      if (scheduledAt > Date.now()) await sleep(scheduledAt - Date.now());
      let result;
      try {
        result = await admitOperation(decision, actors, timeoutMs);
      } catch (error) {
        result = {
          ...decision,
          status: 'ADMISSION_FAILED',
          error: journalError(error),
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
  log.operations.push(...admissionResults);
  await onLog(log);
  const admitted = admissionResults.filter(
    ({ status }) => status === 'ADMITTED',
  );
  if (admitted.length > 0) {
    await waitForTaskQueueIdle({
      actors,
      nodeNames: [...actors.nodes.keys()],
      description: `${label} queue`,
      timeoutMs,
      onProgress,
    });
  }
  const finalized =
    admitted.length > 0 ? await finalizeTasks(admitted, actors) : [];
  const replacements = new Map(
    finalized.map((operation) => [operation.id, operation]),
  );
  log.operations = log.operations.map(
    (operation) => replacements.get(operation.id) ?? operation,
  );

  onProgress(
    `[p2p][${label}][settle] all durable tasks finished; starting incremental convergence`,
  );
  await onLog(log);

  const admissionFailures = admissionResults.filter(
    ({ status }) => status === 'ADMISSION_FAILED',
  );
  if (admissionFailures.length > 0) {
    throw new Error(
      `${admissionFailures.length} operations failed admission: ${admissionFailures
        .map(({ id }) => id)
        .join(', ')}`,
    );
  }
  const unsuccessful = finalized.filter(({ status }) => status !== 'SUCCEEDED');
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
  const random = new SeededRandom(log.seed);
  const rounds = Math.ceil(operationCount / roundSize);
  for (let round = 1; log.operations.length < operationCount; round += 1) {
    const count = Math.min(roundSize, operationCount - log.operations.length);
    const observed = await readP2pConsistencySnapshot(connections, log.users);
    const groupSnapshot = await readGroupWorkloadSnapshot(
      connections,
      observed,
    );
    const decisions = chooseRandomRound({
      log,
      snapshot: observed,
      random,
      count,
      round,
      groupSnapshot,
    });
    if (decisions.length === 0)
      throw new Error('state machine found no executable operation');
    const states = decisions.reduce((result, operation) => {
      const state = operation.type.startsWith('UPDATE_')
        ? 'PROFILE'
        : operation.group
          ? 'GROUP'
          : operation.observedFacts.state;
      result[state] = (result[state] ?? 0) + 1;
      return result;
    }, {});
    const label = `round ${String(round).padStart(2, '0')}`;
    onProgress(
      `[p2p][${label}/${rounds}] selected=${decisions.length} none=${states.NONE ?? 0} ` +
        `pending=${(states.OUTGOING_PENDING ?? 0) + (states.INCOMING_PENDING ?? 0)} ` +
        `friend=${states.FRIEND ?? 0} group=${states.GROUP ?? 0} profile=${states.PROFILE ?? 0}`,
    );
    onProgress(`[p2p][${label}] choices ${actionCounts(decisions)}`);
    await executeBatch({
      label,
      decisions,
      log,
      actors,
      concurrency,
      timeoutMs,
      progressEvery,
      onProgress,
      onLog,
      totalLabel: ` total=${Math.min(round * roundSize, operationCount)}/${operationCount}`,
      operationsPerSecond,
    });
    await waitForFederationConvergence({
      connections,
      log,
      timeoutMs,
      intervalMs: 500,
      stableSamples: 1,
      enforceCoverage: false,
      validateProfiles: false,
      onProgress: (message) =>
        onProgress(
          message.replace('[federation][oracle]', `[p2p][${label}][oracle]`),
        ),
    });
    onProgress(
      `[p2p][${label}] committed ${actionCounts(
        log.operations.slice(-decisions.length),
      )}`,
    );
  }
}
