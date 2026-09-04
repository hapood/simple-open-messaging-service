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
      if (error instanceof LabApiError && error.details?.terminal) throw error;
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
  while (Date.now() < deadline) {
    const snapshots = await Promise.all(
      nodeNames.map(async (nodeName) => ({
        nodeName,
        activity: await actors.node(nodeName).admin.durableTaskActivity(),
      })),
    );
    let pending = 0;
    const processing = [];
    const asyncProcessing = [];
    for (const { nodeName, activity } of snapshots) {
      if (!Number.isInteger(activity?.pendingCount))
        throw new Error(`${nodeName} returned invalid pending task count`);
      pending += activity.pendingCount;
      for (const task of activity.processing ?? [])
        processing.push(`${nodeName}:${String(task.id)}`);
      for (const task of activity.asyncProcessing ?? [])
        asyncProcessing.push(`${nodeName}:${String(task.id)}`);
    }
    const idle =
      pending === 0 && processing.length === 0 && asyncProcessing.length === 0;
    stableIdleSamples = idle ? stableIdleSamples + 1 : 0;
    const perNode = snapshots.map(({ nodeName, activity }) => ({
      nodeName,
      pending: activity.pendingCount,
      processing: (activity.processing ?? []).map(({ id }) => String(id)),
      asyncProcessing: (activity.asyncProcessing ?? []).map(({ id }) =>
        String(id),
      ),
    }));
    const signature = JSON.stringify({ pending, processing, asyncProcessing });
    if (signature !== previousSignature || stableIdleSamples === 2) {
      onProgress(
        `[p2p][drain] ${description}: ` +
          perNode
            .map(
              (node) =>
                `${node.nodeName}{pending=${node.pending},` +
                `processing=[${node.processing.join(',')}],` +
                `async=[${node.asyncProcessing.join(',')}]}`,
            )
            .join(' ') +
          ` elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
      previousSignature = signature;
    }
    // These are three separate status queries. Two empty samples prevent a task transition between
    // requests from producing a false idle barrier.
    if (stableIdleSamples >= 2) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${description}`);
}

export async function waitForIncoming(receiver, initiator, timeoutMs) {
  return waitFor(
    `${receiver.address} incoming invite from ${initiator.address}`,
    timeoutMs,
    async () => {
      if (receiver.node.name === initiator.node.name) {
        let after = 0;
        let through;
        for (;;) {
          const page = await receiver.queryStateFeed({
            mode: 'full',
            after,
            take: 200,
            through,
          });
          through ??= page.stateFeedEndId;
          const item = page.items.find(
            (candidate) =>
              candidate.eventType === 'RELATIONSHIP_INTENT' &&
              candidate.account === initiator.account &&
              candidate.domain === 'local' &&
              candidate.subjectAccount === receiver.account &&
              candidate.subjectDomain === 'local' &&
              candidate.body?.direction === 'INCOMING' &&
              candidate.body?.status === 'REQUESTED' &&
              candidate.body?.expiresAt > Date.now(),
          );
          if (item) {
            return {
              relationship: 'INCOMING_PENDING',
              user: item.body.peer,
            };
          }
          if (!page.hasMore) return undefined;
          if (page.scannedThrough <= after) {
            throw new Error('client state-feed cursor did not advance');
          }
          after = page.scannedThrough;
        }
      }
      const resolved = await receiver.resolveFederatedUser({
        account: initiator.account,
        domain: initiator.domain,
      });
      return resolved?.relationship === 'INCOMING_PENDING'
        ? resolved
        : undefined;
    },
  );
}

export async function resolveWithRetry(actor, peer, timeoutMs) {
  return waitFor(`federated resolve ${peer.address}`, timeoutMs, async () => {
    const resolved = await actor.resolveFederatedUser(peer);
    return resolved?.user?.account === peer.account ? resolved : undefined;
  });
}
