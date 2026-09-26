import 'dotenv/config';
import { createProgressLogger } from './progress-log.mjs';
import '../diagnostics/preload.mjs';
import { randomInt } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FederationLabActors } from './api-actors.mjs';
import { federationLabNodes } from '../topology.mjs';
import {
  buildGroupCreationPlan,
  buildUserPlan,
  SeededRandom,
} from './scenario.mjs';
import { executeRandomP2pWorkload } from './random-execute.mjs';
import {
  closeP2pAuditDatabases,
  connectP2pAuditDatabases,
  readP2pConsistencySnapshot,
} from './audit.mjs';
import {
  attachCreatedGroups,
  readGroupWorkloadSnapshot,
} from './group-facts.mjs';
import { waitForFederationConvergence } from './final-audit.mjs';
import { resolveWorkloadProfiles } from './profile-resolution.mjs';
import { summarizeCoverage } from './coverage.mjs';
import { assertVerificationMode } from './verification-mode.mjs';
import {
  executeForwardRelayScenario,
  provisionForwardRelayUsers,
} from './forward-relay-scenario.mjs';

const p2pDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(p2pDir, '..', 'runtime', 'p2p-runs');

function integerOption(name, fallback, minimum, maximum) {
  const prefix = `--${name}=`;
  const raw = process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix));
  const value = raw ? Number(raw.slice(prefix.length)) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `--${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function stringOption(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix));
  const value = raw ? raw.slice(prefix.length) : fallback;
  if (!/^[a-z][a-z0-9-]{0,9}$/.test(value)) {
    throw new Error(
      `--${name} must start with a lowercase letter and contain at most 10 lowercase letters, digits, or hyphens`,
    );
  }
  return value;
}

function assertKnownOptions() {
  const valued = [
    '--users-per-node=',
    '--groups-per-node=',
    '--operations-per-second=',
    '--concurrency=',
    '--prefix=',
    '--seed=',
    '--operations=',
    '--round-size=',
    '--task-timeout-ms=',
    '--progress-every=',
    '--convergence-timeout-ms=',
    '--convergence-interval-ms=',
    '--convergence-samples=',
    '--verify-mode=',
  ];
  const unknown = process.argv
    .slice(2)
    .filter(
      (argument) =>
        argument !== '--verbose' &&
        !valued.some((prefix) => argument.startsWith(prefix)),
    );
  if (unknown.length > 0) {
    throw new Error(`unknown option: ${unknown.join(' ')}`);
  }
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

async function assertLabReady() {
  await Promise.all(
    federationLabNodes.map(async (node) => {
      let response;
      try {
        response = await fetch(`${node.backendBaseUrl}/api/v1/client/compat`, {
          signal: AbortSignal.timeout(3_000),
        });
      } catch (error) {
        throw new Error(
          `${node.domain} is not reachable at ${node.backendBaseUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `${node.domain} health returned HTTP ${response.status}`,
        );
      }
    }),
  );
}

async function mapConcurrent(items, concurrency, worker) {
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

function shadowOtp(configuration) {
  return configuration.map((policy) =>
    policy.policy === 'auth.otp.login' ? { ...policy, mode: 'shadow' } : policy,
  );
}

async function writeJson(runDir, filename, value) {
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, `${filename}.tmp`),
    `${JSON.stringify(
      value,
      (_key, item) =>
        item instanceof Map
          ? Object.fromEntries(item)
          : item instanceof Set
            ? [...item]
            : item,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await rename(join(runDir, `${filename}.tmp`), join(runDir, filename));
}

function publicUserQuotaDefaults(value) {
  return {
    dailyMsgLimit: value.dailyMsgLimit,
    dailyRequestLimit: value.dailyRequestLimit,
    dailyFileLimit: value.dailyFileLimit,
    dailyFileBytesLimit: String(value.dailyFileBytesLimit),
  };
}

function publicFederationQuotaDefaults(value) {
  return {
    dailyMsgLimit: value.dailyMsgLimit,
    dailyRequestLimit: value.dailyRequestLimit,
    dailySignalLimit: value.dailySignalLimit,
    dailyFileLimit: value.dailyFileLimit,
    dailyFileBytesLimit: value.dailyFileBytesLimit,
  };
}

async function restoreQuotaDefaults(actors, originals) {
  const restorations = await Promise.allSettled(
    [...actors.nodes.values()].map(async ({ topology, admin }) => {
      const original = originals.get(topology.name);
      if (!original) return;
      await Promise.all([
        admin.setUserQuotaDefaults(original.user),
        admin.setFederationQuotaDefaults(original.federation),
      ]);
    }),
  );
  return restorations.filter(({ status }) => status === 'rejected').length;
}

let logProgress = console.log;
let logFailure = console.error;

async function main() {
  assertKnownOptions();
  const usersPerNode = integerOption('users-per-node', 5, 1, 999);
  const groupsPerNode = integerOption('groups-per-node', 5, 1, 999);
  const operationsPerSecond = integerOption(
    'operations-per-second',
    10,
    1,
    100,
  );
  const concurrency = integerOption('concurrency', 12, 1, 100);
  const prefix = stringOption('prefix', 'p2p');
  const seed = integerOption(
    'seed',
    randomInt(1, 0x1_0000_0000),
    1,
    0xffff_ffff,
  );
  const adminPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!adminPassword) {
    throw new Error(
      'ADMIN_BOOTSTRAP_PASSWORD is required; the runner uses it only in memory to call /admin/login on each lab node',
    );
  }
  const baseDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (!baseDatabaseUrl) {
    throw new Error(
      'DATABASE_URL is required; the final pair audit connects read-only to each federation lab database',
    );
  }
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replaceAll(/[-:.TZ]/g, '')}-${prefix}`;
  const runDir = join(runtimeDir, runId);
  await mkdir(runDir, { recursive: true });
  const progressLogger = createProgressLogger(runDir);
  logProgress = progressLogger.info;
  logFailure = progressLogger.error;
  const plan = buildUserPlan(
    prefix,
    usersPerNode,
    new SeededRandom(seed ^ 0xbb67ae85),
  );
  const groupPlan = buildGroupCreationPlan(
    prefix,
    plan,
    groupsPerNode,
    new SeededRandom(seed ^ 0x6a09e667),
  );
  const maximumPairs = (plan.length * (plan.length - 1)) / 2;
  const operationCount = integerOption('operations', 600, 1, 100_000);
  const verifyMode = assertVerificationMode(
    stringOption('verify-mode', 'round'),
  );
  const roundSize = integerOption(
    'round-size',
    Math.min(10, maximumPairs),
    1,
    maximumPairs,
  );
  const taskTimeoutMs = integerOption(
    'task-timeout-ms',
    120_000,
    5_000,
    600_000,
  );
  const progressEvery = integerOption('progress-every', 25, 1, 10_000);
  const convergenceTimeoutMs = integerOption(
    'convergence-timeout-ms',
    300_000,
    5_000,
    1_800_000,
  );
  const convergenceIntervalMs = integerOption(
    'convergence-interval-ms',
    1_000,
    100,
    30_000,
  );
  const convergenceSamples = integerOption('convergence-samples', 3, 2, 20);
  const verbose = hasFlag('verbose');
  const operationLog = {
    seed,
    users: plan.map(({ address }) => address),
    groups: [],
    operations: [],
  };
  const journalVersions = new Map();
  const persistOperationLog = async (value) => {
    for (const operation of value.operations) {
      const serialized = JSON.stringify(operation);
      if (journalVersions.get(operation.id) === serialized) continue;
      await appendFile(
        join(runDir, 'operations.jsonl'),
        `${JSON.stringify({
          recordedAt: new Date().toISOString(),
          operation,
        })}\n`,
        { mode: 0o600 },
      );
      journalVersions.set(operation.id, serialized);
    }
    await writeJson(runDir, 'operations.json', value);
  };
  const report = {
    schemaVersion: 1,
    phase: 'PROVISION_USERS_AND_GROUPS',
    runId,
    status: 'RUNNING',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    configuration: {
      nodes: federationLabNodes.map(({ name, domain, browserBaseUrl }) => ({
        name,
        domain,
        browserBaseUrl,
      })),
      usersPerNode,
      groupsPerNode,
      totalUsers: plan.length,
      totalGroups: groupPlan.length,
      operationsPerSecond,
      concurrency,
      prefix,
      seed,
      operationCount,
      verifyMode,
      roundSize,
      taskTimeoutMs,
      progressEvery,
      verbose,
      convergenceTimeoutMs,
      convergenceIntervalMs,
      convergenceSamples,
    },
    users: [],
    groups: [],
    error: null,
  };
  await Promise.all([
    writeJson(runDir, 'operations.json', operationLog),
    writeJson(runDir, 'provision.json', report),
  ]);

  logProgress(`[p2p] run ${runId}; seed=${seed}; artifacts=${runDir}`);
  logProgress(
    `[p2p] online workload ready: ${operationCount} random decisions in ` +
      `${Math.ceil(operationCount / roundSize)} rounds; direction is chosen before state inspection`,
  );
  logProgress(
    `[p2p] connecting to ${federationLabNodes.length} nodes; provisioning ${plan.length} users through admin + OTP APIs`,
  );
  await assertLabReady();
  const actors = await FederationLabActors.connect({ adminPassword });
  const originalRateLimits = new Map();
  let forwardRelayUsers;
  try {
    await Promise.all(
      [...actors.nodes.values()].map(async ({ topology, admin }) => {
        const configuration = await admin.authRateLimitConfiguration();
        originalRateLimits.set(topology.name, configuration);
        await admin.setAuthRateLimitConfiguration(shadowOtp(configuration));
      }),
    );

    let completed = 0;
    const users = await mapConcurrent(plan, concurrency, async (item) => {
      const actor = await actors.createAndLoginUser(item.nodeName, item);
      if (item.avatar || item.bio) {
        await actor.updateProfile({
          name: item.name,
          bio: item.bio,
          avatar: item.avatar ? 'SET' : 'KEEP',
        });
      }
      const profile = await actor.myProfile();
      if (profile?.id !== actor.id || profile?.account !== actor.account) {
        throw new Error(`${actor.address}: authenticated profile mismatch`);
      }
      completed += 1;
      if (completed === plan.length || completed % 25 === 0) {
        logProgress(`[p2p] users ready ${completed}/${plan.length}`);
      }
      return {
        node: item.nodeName,
        id: actor.id,
        account: actor.account,
        domain: actor.domain,
        address: actor.address,
        profileRev: profile.profileRev,
        name: profile.name,
        bio: profile.bio,
        avatar: Boolean(profile.avatar),
      };
    });
    if (actors.userCount !== plan.length) {
      throw new Error(
        `in-memory actor count ${actors.userCount} does not match plan ${plan.length}`,
      );
    }
    forwardRelayUsers = await provisionForwardRelayUsers(actors);
    report.forwardRelayUsers = forwardRelayUsers.map((user) => user.address);
    let groupsCompleted = 0;
    const createdGroups = await mapConcurrent(
      groupPlan,
      concurrency,
      async (item) => {
        const actor = actors.user(item.owner);
        const avatar = item.avatar ? await actor.uploadAvatar() : undefined;
        const created = await actor.createGroup({
          name: item.name,
          description: item.description,
          avatar,
        });
        if (!Number.isInteger(created?.threadId))
          throw new Error(
            `${item.owner}: group creation returned no thread id`,
          );
        groupsCompleted += 1;
        if (groupsCompleted === groupPlan.length || groupsCompleted % 10 === 0)
          logProgress(
            `[p2p] groups ready ${groupsCompleted}/${groupPlan.length}`,
          );
        return { ...item, threadId: created.threadId };
      },
    );
    const provisioningConnections =
      await connectP2pAuditDatabases(baseDatabaseUrl);
    try {
      const p2pSnapshot = await readP2pConsistencySnapshot(
        provisioningConnections,
        operationLog.users,
      );
      const groupSnapshot = await readGroupWorkloadSnapshot(
        provisioningConnections,
        p2pSnapshot,
      );
      operationLog.groups = attachCreatedGroups(groupSnapshot, createdGroups);
      report.groups = operationLog.groups;
    } finally {
      await closeP2pAuditDatabases(provisioningConnections);
    }
    report.status = 'SUCCEEDED';
    report.users = users;
  } catch (error) {
    report.status = 'FAILED';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const restorations = await Promise.allSettled(
      [...actors.nodes.values()].map(({ topology, admin }) => {
        const configuration = originalRateLimits.get(topology.name);
        return configuration
          ? admin.setAuthRateLimitConfiguration(configuration)
          : Promise.resolve();
      }),
    );
    const failedRestorations = restorations.filter(
      (result) => result.status === 'rejected',
    );
    if (failedRestorations.length > 0) {
      const message = `${failedRestorations.length} node rate-limit configurations were not restored`;
      report.status = 'FAILED';
      report.error = report.error ? `${report.error}; ${message}` : message;
    }
    report.finishedAt = new Date().toISOString();
    await writeJson(runDir, 'provision.json', report);
    logProgress(`[p2p] report ${join(runDir, 'provision.json')}`);
  }

  if (report.status !== 'SUCCEEDED') process.exitCode = 1;
  else {
    logProgress(
      `[p2p] ${actors.userCount} in-memory user actors authenticated; lab remains running for UI inspection`,
    );
  }

  if (report.status !== 'SUCCEEDED') return;

  const operationsPath = join(runDir, 'operations.json');
  const execution = {
    schemaVersion: 1,
    phase: 'EXECUTE_OPERATIONS',
    runId,
    verifyMode,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: operationsPath,
    requestedRandomOperations: operationCount,
    operationCount: 0,
    error: null,
  };
  await writeJson(runDir, 'execution.json', execution);
  const originalQuotas = new Map();
  let quotasRestored = false;
  let workloadConnections;
  try {
    logProgress(
      `[p2p] executing ${operationCount} online random decisions; ` +
        `accepted operations are appended to ${operationsPath}`,
    );
    await Promise.all(
      [...actors.nodes.values()].map(async ({ topology, admin }) => {
        const settings = await admin.settings();
        const user = publicUserQuotaDefaults(settings.userQuotaDefaults);
        const federation = publicFederationQuotaDefaults(
          settings.federationQuotaDefaults,
        );
        originalQuotas.set(topology.name, { user, federation });
        const requestLimit = Math.max(
          user.dailyRequestLimit,
          operationCount * 6,
        );
        const federationRequestLimit = Math.max(
          federation.dailyRequestLimit,
          operationCount * 6,
        );
        await Promise.all([
          admin.setUserQuotaDefaults({
            ...user,
            dailyRequestLimit: requestLimit,
            dailyMsgLimit: Math.max(user.dailyMsgLimit, operationCount * 2),
            dailyFileLimit: Math.max(user.dailyFileLimit, operationCount),
            dailyFileBytesLimit: String(
              BigInt(user.dailyFileBytesLimit) > BigInt(operationCount * 1024)
                ? user.dailyFileBytesLimit
                : operationCount * 1024,
            ),
          }),
          admin.setFederationQuotaDefaults({
            ...federation,
            dailyRequestLimit: federationRequestLimit,
            dailyMsgLimit: Math.max(
              federation.dailyMsgLimit,
              operationCount * 2,
            ),
            dailySignalLimit: Math.max(
              federation.dailySignalLimit,
              operationCount * 4,
            ),
            dailyFileLimit: Math.max(federation.dailyFileLimit, operationCount),
            dailyFileBytesLimit: Math.max(
              federation.dailyFileBytesLimit,
              operationCount * 1024,
            ),
          }),
        ]);
        logProgress(
          `[p2p] ${topology.domain} request quotas raised to user=${requestLimit}, federation=${federationRequestLimit}`,
        );
      }),
    );
    logProgress(
      '[p2p] connecting read-only fact observer to three lab databases',
    );
    workloadConnections = await connectP2pAuditDatabases(baseDatabaseUrl);
    await executeForwardRelayScenario({
      users: forwardRelayUsers,
      connections: workloadConnections,
      log: operationLog,
      timeoutMs: taskTimeoutMs,
      onLog: persistOperationLog,
      onProgress: logProgress,
    });
    await executeRandomP2pWorkload({
      log: operationLog,
      actors,
      connections: workloadConnections,
      operationCount,
      verifyMode,
      roundSize,
      concurrency,
      timeoutMs: taskTimeoutMs,
      progressEvery,
      operationsPerSecond,
      onLog: persistOperationLog,
      onProgress: logProgress,
    });
    execution.operationCount = operationLog.operations.length;
    execution.status = 'SUCCEEDED';
  } catch (error) {
    execution.status = 'FAILED';
    execution.error = error instanceof Error ? error.message : String(error);
    await persistOperationLog(operationLog);
    execution.operationCount = operationLog.operations.length;
    if (error?.snapshot || error?.comparison) {
      await writeJson(runDir, 'execution-failure.json', {
        snapshot: error.snapshot,
        comparison: error.comparison,
        operationIds: operationLog.operations
          .slice(-roundSize)
          .map(({ id }) => id),
      });
    }
    throw error;
  } finally {
    if (workloadConnections) await closeP2pAuditDatabases(workloadConnections);
    const failedRestorations =
      execution.status === 'SUCCEEDED'
        ? 0
        : await restoreQuotaDefaults(actors, originalQuotas);
    quotasRestored = execution.status !== 'SUCCEEDED';
    if (failedRestorations > 0) {
      const message = `${failedRestorations} node quota configurations were not restored`;
      execution.status = 'FAILED';
      execution.error = execution.error
        ? `${execution.error}; ${message}`
        : message;
      logFailure(`[p2p] ${message}`);
    }
    execution.finishedAt = new Date().toISOString();
    await writeJson(runDir, 'execution.json', execution);
    await writeJson(runDir, 'coverage.json', summarizeCoverage(operationLog));
    logProgress(`[p2p] execution report ${join(runDir, 'execution.json')}`);
  }
  if (execution.status !== 'SUCCEEDED') process.exitCode = 1;
  else
    logProgress(
      `[p2p] ${execution.operationCount} logical operations completed; proceeding to final consistency audit`,
    );

  if (execution.status !== 'SUCCEEDED') return;

  const audit = {
    schemaVersion: 1,
    phase: 'AUDIT_FINAL_FEDERATION_STATE',
    runId,
    verifyMode,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    convergenceSamples: null,
    snapshot: null,
    comparison: null,
    error: null,
  };
  await writeJson(runDir, 'audit.json', audit);
  let connections;
  try {
    logProgress('[p2p] connecting read-only auditor to three lab databases');
    connections = await connectP2pAuditDatabases(baseDatabaseUrl);
    // Durable task completion does not include asynchronous peer-state pulls.
    // Resolve profiles only after their relationship authorization has converged.
    logProgress('[p2p] waiting for business state before resolving profiles');
    const { snapshot: profileSnapshot } = await waitForFederationConvergence({
      connections,
      log: operationLog,
      timeoutMs: convergenceTimeoutMs,
      intervalMs: convergenceIntervalMs,
      stableSamples: convergenceSamples,
      onProgress: logProgress,
      validateProfiles: false,
    });
    const profileResolutions = await resolveWorkloadProfiles({
      actors,
      groups: profileSnapshot.groups,
      profiles: profileSnapshot.profiles,
      p2p: profileSnapshot.p2p,
      p2pMessages: profileSnapshot.p2pMessages,
      onProgress: logProgress,
      log: operationLog,
      timeoutMs: taskTimeoutMs,
    });
    await writeJson(runDir, 'profile-resolutions.json', {
      schemaVersion: 1,
      checks: profileResolutions,
    });
    const converged = await waitForFederationConvergence({
      connections,
      log: operationLog,
      timeoutMs: convergenceTimeoutMs,
      intervalMs: convergenceIntervalMs,
      stableSamples: convergenceSamples,
      onProgress: logProgress,
    });
    audit.convergenceSamples = converged.samples;
    audit.snapshot = converged.snapshot;
    audit.comparison = converged.comparison;
    audit.status = audit.comparison.passed ? 'SUCCEEDED' : 'FAILED';
    logProgress(
      `[federation][audit] groups=${audit.comparison.groups}, ` +
        `finalFriends=${audit.comparison.p2pFriends.finalFriends}, ` +
        `messages=${audit.comparison.liveMessages}, ` +
        `withdrawn=${audit.comparison.withdrawnMessages}`,
    );
  } catch (error) {
    audit.status = 'FAILED';
    audit.error = error instanceof Error ? error.message : String(error);
    if (error?.snapshot) audit.snapshot = error.snapshot;
    if (error?.comparison) {
      audit.comparison = error.comparison;
      logFailure(
        `[federation][audit][failures] ${JSON.stringify(error.comparison.failures.slice(0, 50))}`,
      );
    }
  } finally {
    if (connections) await closeP2pAuditDatabases(connections);
    if (!quotasRestored) {
      const failedRestorations = await restoreQuotaDefaults(
        actors,
        originalQuotas,
      );
      quotasRestored = true;
      if (failedRestorations > 0) {
        const message = `${failedRestorations} node quota configurations were not restored`;
        audit.status = 'FAILED';
        audit.error = audit.error ? `${audit.error}; ${message}` : message;
      }
    }
    audit.finishedAt = new Date().toISOString();
    await writeJson(runDir, 'audit.json', audit);
    logProgress(`[p2p] audit report ${join(runDir, 'audit.json')}`);
  }
  if (audit.status !== 'SUCCEEDED') {
    process.exitCode = 1;
    throw new Error(audit.error ?? 'federation final consistency audit failed');
  }
  logProgress(
    '[federation] final intents, rosters, messages, and media PASSED',
  );
}

main().catch((error) => {
  logFailure(`[p2p] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
