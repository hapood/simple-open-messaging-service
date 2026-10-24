import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { federationLabNodes } from '../topology.mjs';

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(probe, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(
    `timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function restartWithDomain(nodeName, domain, timeoutMs) {
  const controlDir = process.env.FED_LAB_CONTROL_DIR;
  if (!controlDir)
    throw new Error('FED_LAB_CONTROL_DIR is required for identity transitions');
  const id = `${Date.now()}-${randomUUID()}`;
  const temporary = join(controlDir, 'requests', `${id}.json.tmp`);
  const request = join(controlDir, 'requests', `${id}.json`);
  const response = join(controlDir, 'responses', `${id}.json`);
  await writeFile(temporary, `${JSON.stringify({ nodeName, domain })}\n`, {
    mode: 0o600,
  });
  await rename(temporary, request);
  return waitFor(
    async () => {
      try {
        const result = JSON.parse(await readFile(response, 'utf8'));
        if (!result.ok) throw new Error(result.error);
        return result;
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    `${nodeName} restart as ${domain}`,
    timeoutMs,
  );
}

function nodeActors(actors) {
  return new Map(
    [...actors.nodes.values()].map((entry) => [entry.topology.name, entry]),
  );
}

/** Random operations and relay chains do not guarantee direct recognition of every pair. */
export async function prepareIdentityTransitionPeers({
  actors,
  domains,
  timeoutMs,
  onProgress = console.log,
}) {
  const byName = nodeActors(actors);
  for (const [sourceName, sourceDomain] of domains) {
    const source = byName.get(sourceName);
    if (!source) throw new Error(`missing actor node ${sourceName}`);
    for (const [peerName, peerDomain] of domains) {
      if (sourceName === peerName) continue;
      if (!byName.has(peerName))
        throw new Error(`missing actor node ${peerName}`);
      onProgress(
        `[p2p][identity-transition prerequisite] ${sourceDomain} recognizing ${peerDomain}`,
      );
      await source.admin.post(
        `/admin/federation/peers/${encodeURIComponent(peerDomain)}/recognize`,
        {},
        `establish pre-transition identity for ${peerDomain}`,
      );
    }
  }
  // Inspect after both directions have recognized, before changing any identity.
  const pinnedPeers = [];
  for (const [sourceName, sourceDomain] of domains) {
    const source = byName.get(sourceName);
    for (const [peerName, peerDomain] of domains) {
      if (sourceName === peerName) continue;
      const detail = await waitFor(
        async () => {
          const peer = await source.admin.post(
            `/admin/federation/peers/${encodeURIComponent(peerDomain)}`,
            {},
            `read pre-transition identity for ${peerDomain}`,
          );
          return peer?.active &&
            peer.rootPublicKey &&
            peer.identityPinnedAt &&
            peer.trustLevel === 'available'
            ? peer
            : undefined;
        },
        `${peerDomain} to be pinned and available on ${sourceDomain} before identity transitions`,
        timeoutMs,
      );
      pinnedPeers.push({
        observer: sourceDomain,
        peer: peerDomain,
        rootPublicKey: detail.rootPublicKey,
      });
    }
  }
  return pinnedPeers;
}

async function pendingReview(admin, kind, nextDomain) {
  const reviews = await admin.post(
    '/admin/federation/identity-reviews',
    {},
    'list pending identity reviews',
  );
  return reviews.find(
    (review) => review.kind === kind && review.nextDomain === nextDomain,
  );
}

async function establishWithPeers({
  actors,
  sourceName,
  sourceDomain,
  peerDomains,
  reviewKind,
  timeoutMs,
  onProgress,
}) {
  const byName = nodeActors(actors);
  const source = byName.get(sourceName);
  if (!source) throw new Error(`missing actor node ${sourceName}`);
  for (const [peerName, peerDomain] of peerDomains) {
    const peer = byName.get(peerName);
    onProgress(
      `[p2p][identity-transition] ${sourceDomain} recognizing ${peerDomain}`,
    );
    await source.admin.post(
      `/admin/federation/peers/${encodeURIComponent(peerDomain)}/recognize`,
      {},
      `recognize ${peerDomain}`,
    );
    const review = await waitFor(
      () => pendingReview(peer.admin, reviewKind, sourceDomain),
      `${reviewKind} review for ${sourceDomain} on ${peerDomain}`,
      timeoutMs,
    );
    // Approving a root-rotation review runs the predecessor possession
    // challenge server-side; a failed continuity check rejects the approval
    // with FEDERATION_ROOT_CHANGE_REJECTED, so no separate probe is needed.
    await peer.admin.post(
      `/admin/federation/identity-reviews/${review.id}/approve`,
      {},
      `approve ${reviewKind} for ${sourceDomain}`,
    );
    await source.admin.post(
      `/admin/federation/peers/${encodeURIComponent(peerDomain)}/recognize`,
      {},
      `complete recognition with ${peerDomain}`,
    );
    await waitFor(
      async () => {
        const detail = await peer.admin.post(
          `/admin/federation/peers/${encodeURIComponent(sourceDomain)}`,
          {},
          `read ${sourceDomain} lifecycle`,
        );
        return detail?.trustLevel === 'available' ? detail : undefined;
      },
      `${sourceDomain} to become available on ${peerDomain}`,
      timeoutMs,
    );
  }
}

async function rotateRoot({ actors, node, domains, timeoutMs, onProgress }) {
  const entry = nodeActors(actors).get(node.name);
  onProgress(
    `[p2p][identity-transition] ${node.domain} rotating federation root certificate`,
  );
  const rotation = await entry.admin.post(
    '/admin/federation/local-root-epochs/rotate',
    {},
    'rotate local federation root',
  );
  await establishWithPeers({
    actors,
    sourceName: node.name,
    sourceDomain: domains.get(node.name),
    peerDomains: [...domains].filter(([name]) => name !== node.name),
    reviewKind: 'root-rotation',
    timeoutMs,
    onProgress,
  });
  return rotation;
}

async function rebindRoundTrip({
  actors,
  node,
  domains,
  timeoutMs,
  onProgress,
}) {
  const transitions = [];
  for (const nextDomain of [node.transitionDomain, node.domain]) {
    onProgress(
      `[p2p][identity-transition] ${node.name} rebinding ${domains.get(node.name)} -> ${nextDomain}`,
    );
    await restartWithDomain(node.name, nextDomain, timeoutMs);
    domains.set(node.name, nextDomain);
    await establishWithPeers({
      actors,
      sourceName: node.name,
      sourceDomain: nextDomain,
      peerDomains: [...domains].filter(([name]) => name !== node.name),
      reviewKind: 'domain-rebind',
      timeoutMs,
      onProgress,
    });
    transitions.push(nextDomain);
  }
  return transitions;
}

export async function executeIdentityTransitionCheckpoint({
  actors,
  log,
  timeoutMs,
  onProgress = console.log,
  onLog = async () => {},
}) {
  if (!process.env.FED_LAB_CONTROL_DIR) {
    throw new Error(
      'identity transition checkpoint requires the federation:test diagnostic launcher',
    );
  }
  const domains = new Map(
    federationLabNodes.map((node) => [node.name, node.domain]),
  );
  const [alpha, bravo, charlie] = federationLabNodes;
  const report = {
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    certificateOnly: null,
    domainOnly: null,
    domainAndCertificate: null,
  };
  log.identityTransitions = report;
  await onLog(log);
  try {
    report.pinnedPeers = await prepareIdentityTransitionPeers({
      actors,
      domains,
      timeoutMs,
      onProgress,
    });
    await onLog(log);
    report.certificateOnly = await rotateRoot({
      actors,
      node: alpha,
      domains,
      timeoutMs,
      onProgress,
    });
    report.domainOnly = await rebindRoundTrip({
      actors,
      node: bravo,
      domains,
      timeoutMs,
      onProgress,
    });
    const rotation = await rotateRoot({
      actors,
      node: charlie,
      domains,
      timeoutMs,
      onProgress,
    });
    const rebind = await rebindRoundTrip({
      actors,
      node: charlie,
      domains,
      timeoutMs,
      onProgress,
    });
    report.domainAndCertificate = { rotation, rebind };
    report.status = 'SUCCEEDED';
  } catch (error) {
    report.status = 'FAILED';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await onLog(log);
  }
  onProgress(
    '[p2p][identity-transition] certificate, domain, and combined re-entry completed; resuming workload',
  );
}
