import { pairKey, SeededRandom } from './scenario.mjs';
import { observeDirectedPair } from './operation-log.mjs';
import { readP2pConsistencySnapshot } from './audit.mjs';
import { LabApiError } from './api-actors.mjs';
import {
  mapConcurrent,
  resolveWithRetry,
  waitForIncoming,
  waitForTaskQueueIdle,
} from './execute.mjs';

const FACT_SETTLEMENT_DELAY_MS = 5_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function allPairs(users) {
  const pairs = [];
  for (let left = 0; left < users.length; left += 1) {
    for (let right = left + 1; right < users.length; right += 1) {
      pairs.push([users[left], users[right]]);
    }
  }
  return pairs;
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

function choosePendingAction(random) {
  const choices = ['ACCEPT_REQUEST', 'REVERSE_REQUEST', 'REJECT_REQUEST'];
  return { type: choices[random.integer(choices.length)], choices };
}

export function chooseRandomRound({
  log,
  snapshot,
  random,
  count,
  round = 1,
  operationOffset = log.operations.length,
}) {
  const candidates = shuffle(allPairs(log.users), random).slice(0, count);
  return candidates.map(([canonicalLeft, canonicalRight], index) => {
    const selectedAuthor = random.boolean() ? canonicalLeft : canonicalRight;
    const selectedSubject =
      selectedAuthor === canonicalLeft ? canonicalRight : canonicalLeft;
    const observedFacts = observeDirectedPair(
      snapshot,
      selectedAuthor,
      selectedSubject,
    );
    const common = {
      id: operationId(operationOffset + index),
      round,
      pair: pairKey(selectedAuthor, selectedSubject),
      selectedAuthor,
      selectedSubject,
      selectedDirection: `${selectedAuthor}->${selectedSubject}`,
      observedFacts,
    };
    if (observedFacts.state === 'NONE') {
      return {
        ...common,
        type: 'SEND_REQUEST',
        actor: selectedAuthor,
        peer: selectedSubject,
        decisionOptions: ['SEND_REQUEST'],
      };
    }
    if (observedFacts.state === 'FRIEND') {
      return {
        ...common,
        type: 'REVOKE_RELATIONSHIP',
        actor: selectedAuthor,
        peer: selectedSubject,
        decisionOptions: ['REVOKE_RELATIONSHIP'],
      };
    }
    const outgoing = observedFacts.state === 'OUTGOING_PENDING';
    const requestAuthor = outgoing ? selectedAuthor : selectedSubject;
    const requestSubject = outgoing ? selectedSubject : selectedAuthor;
    const selected = choosePendingAction(random);
    return {
      ...common,
      type: selected.type,
      actor: requestSubject,
      requestAuthor,
      requestSubject,
      decisionOptions: selected.choices,
    };
  });
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

async function admitOperation(operation, actors, timeoutMs) {
  let admission;
  if (operation.type === 'SEND_REQUEST') {
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
  if (typeof admission.accepted?.taskId !== 'string') {
    throw new Error(`${operation.id}: admission returned no durable task id`);
  }
  return {
    ...operation,
    actor: admission.actor.address,
    request: admission.request,
    ...(admission.preflight ? { preflight: admission.preflight } : {}),
    taskId: admission.accepted.taskId,
    taskNode: admission.actor.node.name,
    status: 'ADMITTED',
    admittedAt: new Date().toISOString(),
  };
}

function actionCounts(operations) {
  const counts = {};
  for (const operation of operations) {
    const key =
      operation.request?.endpoint ??
      (operation.type === 'ACCEPT_REQUEST'
        ? '/relationship/accept'
        : operation.type === 'REJECT_REQUEST' ||
            operation.type === 'REVOKE_RELATIONSHIP'
          ? '/relationship/revoke'
          : '/relationship/request');
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
}) {
  const admissionStarted = Date.now();
  let completed = 0;
  const admissionResults = await mapConcurrent(
    decisions,
    concurrency,
    async (decision) => {
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
    `[p2p][${label}][settle] all durable tasks finished; waiting ` +
      `${FACT_SETTLEMENT_DELAY_MS / 1_000}s for federation propagation`,
  );
  await sleep(FACT_SETTLEMENT_DELAY_MS);
  onProgress(`[p2p][${label}][settle] propagation delay complete`);
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
  onProgress = console.log,
  onLog = async () => {},
}) {
  const random = new SeededRandom(log.seed);
  const rounds = Math.ceil(operationCount / roundSize);
  for (let round = 1; round <= rounds; round += 1) {
    const count = Math.min(roundSize, operationCount - log.operations.length);
    const observed = await readP2pConsistencySnapshot(connections, log.users);
    const decisions = chooseRandomRound({
      log,
      snapshot: observed,
      random,
      count,
      round,
    });
    const states = decisions.reduce((result, operation) => {
      const state = operation.observedFacts.state;
      result[state] = (result[state] ?? 0) + 1;
      return result;
    }, {});
    const label = `round ${String(round).padStart(2, '0')}`;
    onProgress(
      `[p2p][${label}/${rounds}] selected=${count} none=${states.NONE ?? 0} ` +
        `pending=${(states.OUTGOING_PENDING ?? 0) + (states.INCOMING_PENDING ?? 0)} ` +
        `friend=${states.FRIEND ?? 0}`,
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
    });
    onProgress(
      `[p2p][${label}] committed ${actionCounts(
        log.operations.slice(-decisions.length),
      )}`,
    );
  }
}
