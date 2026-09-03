import 'dotenv/config';
import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FederationLabActors } from './api-actors.mjs';
import { federationLabNodes } from '../topology.mjs';
import { buildUserPlan } from './scenario.mjs';
import { executeRandomP2pWorkload } from './random-execute.mjs';
import { P2P_OPERATION_LOG_SCHEMA_VERSION } from './operation-log.mjs';
import {
  closeP2pAuditDatabases,
  connectP2pAuditDatabases,
  waitForP2pFriendConvergence,
} from './audit.mjs';

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
        response = await fetch(`${node.backendBaseUrl}/api/v1/health`, {
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
    join(runDir, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
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

async function main() {
  assertKnownOptions();
  const usersPerNode = integerOption('users-per-node', 20, 1, 999);
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
  const plan = buildUserPlan(prefix, usersPerNode);
  const maximumPairs = (plan.length * (plan.length - 1)) / 2;
  const operationCount = integerOption('operations', 600, 1, 100_000);
  const roundSize = integerOption(
    'round-size',
    Math.min(60, maximumPairs),
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
    schemaVersion: P2P_OPERATION_LOG_SCHEMA_VERSION,
    seed,
    users: plan.map(({ address }) => address),
    operations: [],
  };
  const report = {
    schemaVersion: 1,
    phase: 'PROVISION_USERS',
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
      totalUsers: plan.length,
      concurrency,
      prefix,
      seed,
      operationCount,
      roundSize,
      taskTimeoutMs,
      progressEvery,
      verbose,
      convergenceTimeoutMs,
      convergenceIntervalMs,
      convergenceSamples,
    },
    users: [],
    error: null,
  };
  await Promise.all([
    writeJson(runDir, 'operations.json', operationLog),
    writeJson(runDir, 'provision.json', report),
  ]);

  console.log(`[p2p] run ${runId}; seed=${seed}; artifacts=${runDir}`);
  console.log(
    `[p2p] online workload ready: ${operationCount} random decisions in ` +
      `${Math.ceil(operationCount / roundSize)} rounds; direction is chosen before state inspection`,
  );
  console.log(
    `[p2p] connecting to ${federationLabNodes.length} nodes; provisioning ${plan.length} users through admin + OTP APIs`,
  );
  await assertLabReady();
  const actors = await FederationLabActors.connect({ adminPassword });
  const originalRateLimits = new Map();
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
      const profile = await actor.myProfile();
      if (profile?.id !== actor.id || profile?.account !== actor.account) {
        throw new Error(`${actor.address}: authenticated profile mismatch`);
      }
      completed += 1;
      if (completed === plan.length || completed % 25 === 0) {
        console.log(`[p2p] users ready ${completed}/${plan.length}`);
      }
      return {
        node: item.nodeName,
        id: actor.id,
        account: actor.account,
        domain: actor.domain,
        address: actor.address,
      };
    });
    if (actors.userCount !== plan.length) {
      throw new Error(
        `in-memory actor count ${actors.userCount} does not match plan ${plan.length}`,
      );
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
    console.log(`[p2p] report ${join(runDir, 'provision.json')}`);
  }

  if (report.status !== 'SUCCEEDED') process.exitCode = 1;
  else {
    console.log(
      `[p2p] ${actors.userCount} in-memory user actors authenticated; lab remains running for UI inspection`,
    );
  }

  if (report.status !== 'SUCCEEDED') return;

  const operationsPath = join(runDir, 'operations.json');
  const execution = {
    schemaVersion: 1,
    phase: 'EXECUTE_OPERATIONS',
    runId,
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
  let workloadConnections;
  try {
    console.log(
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
          }),
          admin.setFederationQuotaDefaults({
            ...federation,
            dailyRequestLimit: federationRequestLimit,
          }),
        ]);
        console.log(
          `[p2p] ${topology.domain} request quotas raised to user=${requestLimit}, federation=${federationRequestLimit}`,
        );
      }),
    );
    console.log(
      '[p2p] connecting read-only fact observer to three lab databases',
    );
    workloadConnections = await connectP2pAuditDatabases(baseDatabaseUrl);
    await executeRandomP2pWorkload({
      log: operationLog,
      actors,
      connections: workloadConnections,
      operationCount,
      roundSize,
      concurrency,
      timeoutMs: taskTimeoutMs,
      progressEvery,
      onLog: (value) => writeJson(runDir, 'operations.json', value),
    });
    execution.operationCount = operationLog.operations.length;
    execution.status = 'SUCCEEDED';
  } catch (error) {
    execution.status = 'FAILED';
    execution.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (workloadConnections) await closeP2pAuditDatabases(workloadConnections);
    const restorations = await Promise.allSettled(
      [...actors.nodes.values()].map(async ({ topology, admin }) => {
        const original = originalQuotas.get(topology.name);
        if (!original) return;
        await Promise.all([
          admin.setUserQuotaDefaults(original.user),
          admin.setFederationQuotaDefaults(original.federation),
        ]);
      }),
    );
    const failed = restorations.filter(({ status }) => status === 'rejected');
    if (failed.length > 0) {
      const message = `${failed.length} node quota configurations were not restored`;
      execution.status = 'FAILED';
      execution.error = execution.error
        ? `${execution.error}; ${message}`
        : message;
      console.error(`[p2p] ${message}`);
    }
    execution.finishedAt = new Date().toISOString();
    await writeJson(runDir, 'execution.json', execution);
    console.log(`[p2p] execution report ${join(runDir, 'execution.json')}`);
  }
  if (execution.status !== 'SUCCEEDED') process.exitCode = 1;
  else
    console.log(
      `[p2p] all ${execution.operationCount} online random operations SUCCEEDED`,
    );

  if (execution.status !== 'SUCCEEDED') return;

  const audit = {
    schemaVersion: 1,
    phase: 'AUDIT_FINAL_P2P_FRIENDS',
    runId,
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
    console.log('[p2p] connecting read-only auditor to three lab databases');
    connections = await connectP2pAuditDatabases(baseDatabaseUrl);
    const converged = await waitForP2pFriendConvergence({
      connections,
      users: operationLog.users,
      timeoutMs: convergenceTimeoutMs,
      intervalMs: convergenceIntervalMs,
      stableSamples: convergenceSamples,
    });
    audit.convergenceSamples = converged.samples;
    audit.snapshot = converged.snapshot;
    audit.comparison = converged.comparison;
    audit.status = audit.comparison.passed ? 'SUCCEEDED' : 'FAILED';
    for (const node of federationLabNodes) {
      const result = audit.comparison.nodes[node.name];
      console.log(
        `[p2p][audit] ${node.domain}: ${result.passed ? 'PASS' : 'FAIL'} ` +
          `active=${result.activeCount}, duplicates=${result.duplicates.length}, ` +
          `invalid=${result.invalid.length}, misplacedActive=${result.misplacedActive.length}`,
      );
    }
    console.log(
      `[p2p][audit] finalFriends=${audit.comparison.finalFriends}, ` +
        `crossNodePairs=${audit.comparison.crossNodePairs}, ` +
        `activeMismatch=${audit.comparison.mismatches.length}`,
    );
  } catch (error) {
    audit.status = 'FAILED';
    audit.error = error instanceof Error ? error.message : String(error);
    if (error?.snapshot) audit.snapshot = error.snapshot;
    if (error?.comparison) {
      audit.comparison = error.comparison;
      for (const node of federationLabNodes) {
        const result = error.comparison.nodes[node.name];
        if (result.passed) continue;
        console.error(
          `[p2p][audit][${node.name}] ` +
            JSON.stringify({
              duplicates: result.duplicates,
              invalid: result.invalid,
              misplacedActive: result.misplacedActive,
            }),
        );
      }
      if (error.comparison.mismatches.length > 0)
        console.error(
          `[p2p][audit][active-mismatch] ${JSON.stringify(error.comparison.mismatches)}`,
        );
    }
  } finally {
    if (connections) await closeP2pAuditDatabases(connections);
    audit.finishedAt = new Date().toISOString();
    await writeJson(runDir, 'audit.json', audit);
    console.log(`[p2p] audit report ${join(runDir, 'audit.json')}`);
  }
  if (audit.status !== 'SUCCEEDED') {
    process.exitCode = 1;
    throw new Error(audit.error ?? 'P2P final friend audit failed');
  }
  console.log('[p2p] final RelationshipPair.active federation symmetry PASSED');
}

main().catch((error) => {
  console.error(
    `[p2p] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
