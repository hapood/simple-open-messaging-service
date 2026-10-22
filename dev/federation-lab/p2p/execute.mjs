import { LabApiError } from './api-actors.mjs';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorDetails(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof LabApiError ? { details: error.details } : {}),
  };
}

async function waitFor(description, timeoutMs, inspect) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await inspect();
      if (value !== undefined && value !== false && value !== null)
        return value;
    } catch (error) {
      if (
        error instanceof LabApiError &&
        (error.details?.terminal ||
          ['NOT_FOUND', 'BLOCKED', 'INVALID_ADDRESS'].includes(
            error.details?.reason,
          ))
      )
        throw error;
      lastError = error;
    }
    await sleep(200);
  }
  const suffix = lastError
    ? `; last error: ${errorDetails(lastError).message}`
    : '';
  throw new Error(`timed out waiting for ${description}${suffix}`);
}

export async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function waitForTaskQueueIdle({
  actors,
  nodeNames,
  description,
  timeoutMs,
  onProgress,
}) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let stableIdleSamples = 0;
  let previousSignature;
  let lastLoggedAt = 0;
  let sample = 0;
  let queryTotalMs = 0;
  let sleepTotalMs = 0;
  while (Date.now() < deadline) {
    sample += 1;
    const sampleStartedAt = performance.now();
    const snapshots = await Promise.all(
      nodeNames.map(async (nodeName) => {
        const nodeStartedAt = performance.now();
        const activity = await actors
          .node(nodeName)
          .admin.durableTaskActivity();
        return {
          nodeName,
          activity,
          durationMs: Math.round(performance.now() - nodeStartedAt),
        };
      }),
    );
    const sampleMs = Math.round(performance.now() - sampleStartedAt);
    queryTotalMs += sampleMs;
    let pending = 0;
    const processing = [];
    for (const { nodeName, activity } of snapshots) {
      if (activity.failedCount > 0 || activity.failed?.length > 0) {
        const failures = (activity.failed ?? []).map(
          (task) =>
            `${task.id} ${task.taskType} scope=${task.scopeKey}: ${task.lastError ?? 'unknown error'}`,
        );
        throw new Error(
          `${description}: ${nodeName} has ${activity.failedCount ?? activity.failed.length} FAILED durable tasks; ${failures.join('; ')}`,
        );
      }
      if (!Number.isInteger(activity?.pendingCount))
        throw new Error(`${nodeName} returned invalid pending task count`);
      pending += activity.pendingCount;
      for (const task of activity.processing ?? [])
        processing.push(`${nodeName}:${String(task.id)}`);
    }
    const idle = pending === 0 && processing.length === 0;
    stableIdleSamples = idle ? stableIdleSamples + 1 : 0;
    const perNode = snapshots.map(({ nodeName, activity, durationMs }) => ({
      nodeName,
      durationMs,
      queryMs: activity.queryMs,
      pending: activity.pendingCount,
      processing: (activity.processing ?? []).map(({ id }) => String(id)),
    }));
    const signature = JSON.stringify({ pending, processing });
    if (
      signature !== previousSignature ||
      stableIdleSamples === 2 ||
      sampleMs >= 1000 ||
      Date.now() - lastLoggedAt >= 5000
    ) {
      onProgress(
        `[p2p][drain] ${description}: ` +
          perNode
            .map(
              (node) =>
                `${node.nodeName}{pending=${node.pending},` +
                `processing=[${node.processing.join(',')}],` +
                `queryMs=${node.durationMs}` +
                (node.queryMs
                  ? `,statusMs=[${Object.entries(node.queryMs)
                      .sort(([left], [right]) => left.localeCompare(right))
                      .map(([status, duration]) => `${status}:${duration}`)
                      .join(',')}]`
                  : '') +
                `}`,
            )
            .join(' ') +
          ` sample=${sample} idleSamples=${stableIdleSamples}/2 sampleMs=${sampleMs}` +
          ` queryTotalMs=${queryTotalMs} sleepTotalMs=${sleepTotalMs}` +
          ` elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
      previousSignature = signature;
      lastLoggedAt = Date.now();
    }
    // These are separate status queries. Two empty samples prevent a task transition between
    // requests from producing a false idle barrier.
    if (stableIdleSamples >= 2) return;
    const sleepStartedAt = performance.now();
    await sleep(500);
    sleepTotalMs += Math.round(performance.now() - sleepStartedAt);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** Incoming rounds live in the receiver's permanent request history (the
 * RECEIVED bucket); the retired client intent-feed event rows no longer carry
 * them. A live FRIEND round from the initiator marks the pending invite. */
export async function waitForIncoming(receiver, initiator, timeoutMs) {
  return waitFor(
    `${receiver.address} incoming invite from ${initiator.address}`,
    timeoutMs,
    async () => {
      const page = await receiver.post('/relationship/requests', {
        bucket: 'RECEIVED',
        take: 50,
      });
      const item = page?.items?.find(
        (candidate) =>
          candidate.kind === 'FRIEND' &&
          candidate.status === 'REQUESTED' &&
          candidate.author?.account === initiator.account &&
          Date.parse(candidate.expiresAt) > Date.now(),
      );
      if (!item) return undefined;
      return {
        relationship: 'INCOMING_PENDING',
        requestId: item.id,
        user: { account: initiator.account },
      };
    },
  );
}

export async function resolveWithRetry(actor, peer, timeoutMs) {
  return waitFor(`federated resolve ${peer.address}`, timeoutMs, async () => {
    const resolved = await actor.resolveFederatedUser(peer);
    return resolved?.user?.account === peer.account ? resolved : undefined;
  });
}
