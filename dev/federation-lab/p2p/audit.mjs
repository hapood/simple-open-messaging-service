import { Client } from 'pg';
import { federationLabDatabaseUrl, federationLabNodes } from '../topology.mjs';
import { pairKey } from './scenario.mjs';

function normalizeAddress(node, account, domain) {
  return `${account}@${domain === 'local' ? node.domain : domain}`;
}

function directionKey(author, subject) {
  return `${author}->${subject}`;
}

export function normalizeNodePairRows(node, rows, users) {
  const cohort = users instanceof Set ? users : new Set(users);
  const all = new Set();
  const active = new Set();
  const duplicates = [];
  const invalid = [];

  for (const row of rows) {
    if (row.endpointatype !== 'USER' || row.endpointbtype !== 'USER') {
      if (row.active)
        invalid.push({ id: row.id, reason: 'P2P endpoint type is not USER' });
      continue;
    }
    const left = normalizeAddress(
      node,
      row.endpointaaccount,
      row.endpointadomain,
    );
    const right = normalizeAddress(
      node,
      row.endpointbaccount,
      row.endpointbdomain,
    );
    if (!cohort.has(left) || !cohort.has(right)) continue;
    let key;
    try {
      key = pairKey(left, right);
    } catch (error) {
      if (row.active)
        invalid.push({
          id: row.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      continue;
    }
    all.add(key);
    if (row.active) {
      if (active.has(key)) duplicates.push({ pair: key, id: row.id });
      active.add(key);
    }
  }

  return {
    all: [...all].sort(),
    active: [...active].sort(),
    duplicates,
    invalid,
  };
}

async function readNodeRows(client) {
  const result = await client.query(`
    SELECT
      "id"::text AS id,
      "endpointAType" AS endpointatype,
      "endpointAAccount" AS endpointaaccount,
      "endpointADomain" AS endpointadomain,
      "endpointBType" AS endpointbtype,
      "endpointBAccount" AS endpointbaccount,
      "endpointBDomain" AS endpointbdomain,
      "active" AS active
    FROM "RelationshipPair"
    WHERE "kind" = 'P2P'
    ORDER BY "id"
  `);
  return result.rows;
}

async function readNodeIntentRows(client) {
  const result = await client.query(`
    SELECT
      intent."id"::text AS id,
      intent."authorSide" AS authorside,
      intent."status" AS status,
      intent."expiresAt" AS expiresat,
      pair."endpointAType" AS endpointatype,
      pair."endpointAAccount" AS endpointaaccount,
      pair."endpointADomain" AS endpointadomain,
      pair."endpointBType" AS endpointbtype,
      pair."endpointBAccount" AS endpointbaccount,
      pair."endpointBDomain" AS endpointbdomain
    FROM "RelationshipIntent" intent
    INNER JOIN "RelationshipPair" pair ON pair."id" = intent."pairId"
    WHERE pair."kind" = 'P2P'
    ORDER BY intent."id"
  `);
  return result.rows;
}

export function normalizeNodeIntentRows(node, rows, users) {
  const cohort = users instanceof Set ? users : new Set(users);
  const directions = new Map();
  const duplicates = [];
  const invalid = [];
  for (const row of rows) {
    if (row.endpointatype !== 'USER' || row.endpointbtype !== 'USER') {
      invalid.push({ id: row.id, reason: 'P2P endpoint type is not USER' });
      continue;
    }
    if (row.authorside !== 'A' && row.authorside !== 'B') {
      invalid.push({
        id: row.id,
        reason: 'invalid relationship intent authorSide',
      });
      continue;
    }
    const endpointA = normalizeAddress(
      node,
      row.endpointaaccount,
      row.endpointadomain,
    );
    const endpointB = normalizeAddress(
      node,
      row.endpointbaccount,
      row.endpointbdomain,
    );
    if (!cohort.has(endpointA) || !cohort.has(endpointB)) continue;
    const author = row.authorside === 'A' ? endpointA : endpointB;
    const subject = row.authorside === 'A' ? endpointB : endpointA;
    const key = directionKey(author, subject);
    if (directions.has(key)) duplicates.push({ direction: key, id: row.id });
    const expiresAt =
      row.expiresat instanceof Date
        ? row.expiresat.toISOString()
        : (row.expiresat ?? null);
    directions.set(key, {
      author,
      subject,
      status: row.status,
      expiresAt,
    });
  }
  return {
    directions: [...directions.values()].sort((left, right) =>
      directionKey(left.author, left.subject).localeCompare(
        directionKey(right.author, right.subject),
      ),
    ),
    duplicates,
    invalid,
  };
}

export async function connectP2pAuditDatabases(baseDatabaseUrl) {
  if (!baseDatabaseUrl)
    throw new Error('DATABASE_URL is required for P2P audit');
  const connections = new Map();
  try {
    for (const node of federationLabNodes) {
      const client = new Client({
        connectionString: federationLabDatabaseUrl(
          baseDatabaseUrl,
          node.database,
        ),
      });
      await client.connect();
      await client.query(
        'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
      );
      connections.set(node.name, { node, client });
    }
    return connections;
  } catch (error) {
    await Promise.allSettled(
      [...connections.values()].map(({ client }) => client.end()),
    );
    throw error;
  }
}

export async function closeP2pAuditDatabases(connections) {
  await Promise.allSettled(
    [...connections.values()].map(({ client }) => client.end()),
  );
}

export async function readP2pPairSnapshot(connections, users) {
  const entries = await Promise.all(
    [...connections.values()].map(async ({ node, client }) => {
      const rows = await readNodeRows(client);
      return [node.name, normalizeNodePairRows(node, rows, users)];
    }),
  );
  return Object.fromEntries(entries);
}

export async function readP2pConsistencySnapshot(connections, users) {
  const entries = await Promise.all(
    [...connections.values()].map(async ({ node, client }) => {
      const [pairRows, intentRows] = await Promise.all([
        readNodeRows(client),
        readNodeIntentRows(client),
      ]);
      return [
        node.name,
        {
          pairs: normalizeNodePairRows(node, pairRows, users),
          intents: normalizeNodeIntentRows(node, intentRows, users),
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

function addressDomain(address) {
  return address.slice(address.lastIndexOf('@') + 1);
}

function nodeForDomain(domain) {
  return federationLabNodes.find((node) => node.domain === domain);
}

export function compareFinalP2pFriends(snapshot, users) {
  const activeByNode = Object.fromEntries(
    federationLabNodes.map((node) => [
      node.name,
      new Set(snapshot[node.name].active),
    ]),
  );
  const nodes = {};
  let passed = true;
  for (const node of federationLabNodes) {
    const actual = snapshot[node.name];
    const misplacedActive = actual.active.filter((key) => {
      const [left, right] = key.split('|');
      return (
        addressDomain(left) !== node.domain &&
        addressDomain(right) !== node.domain
      );
    });
    const result = {
      activeCount: actual.active.length,
      duplicates: actual.duplicates,
      invalid: actual.invalid,
      misplacedActive,
    };
    result.passed =
      result.duplicates.length === 0 &&
      result.invalid.length === 0 &&
      result.misplacedActive.length === 0;
    if (!result.passed) passed = false;
    nodes[node.name] = result;
  }

  const mismatches = [];
  let crossNodePairs = 0;
  let finalFriends = 0;
  for (let leftIndex = 0; leftIndex < users.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < users.length;
      rightIndex += 1
    ) {
      const left = users[leftIndex];
      const right = users[rightIndex];
      const leftNode = nodeForDomain(addressDomain(left));
      const rightNode = nodeForDomain(addressDomain(right));
      if (!leftNode || !rightNode)
        throw new Error(`no federation lab node owns ${left} or ${right}`);
      const key = pairKey(left, right);
      const leftActive = activeByNode[leftNode.name].has(key);
      if (leftNode.name === rightNode.name) {
        if (leftActive) finalFriends += 1;
        continue;
      }
      crossNodePairs += 1;
      const rightActive = activeByNode[rightNode.name].has(key);
      if (leftActive !== rightActive) {
        mismatches.push({
          pair: key,
          leftNode: leftNode.name,
          leftActive,
          rightNode: rightNode.name,
          rightActive,
        });
      } else if (leftActive) finalFriends += 1;
    }
  }
  if (mismatches.length > 0) passed = false;
  return { passed, crossNodePairs, finalFriends, mismatches, nodes };
}

export async function waitForP2pFriendConvergence({
  connections,
  users,
  timeoutMs,
  intervalMs,
  stableSamples,
  onProgress = console.log,
}) {
  const deadline = Date.now() + timeoutMs;
  let passingSamples = 0;
  let sample = 0;
  let latest;
  let comparison;
  while (Date.now() < deadline) {
    sample += 1;
    latest = await readP2pPairSnapshot(connections, users);
    comparison = compareFinalP2pFriends(latest, users);
    passingSamples = comparison.passed ? passingSamples + 1 : 0;
    const activeCount = Object.values(latest).reduce(
      (total, node) => total + node.active.length,
      0,
    );
    onProgress(
      `[p2p][oracle] sample=${sample} pass=${comparison.passed} ` +
        `stable=${passingSamples}/${stableSamples} active=${activeCount} ` +
        `finalFriends=${comparison.finalFriends} ` +
        `activeMismatch=${comparison.mismatches.length}`,
    );
    if (passingSamples >= stableSamples) {
      return { snapshot: latest, comparison, samples: sample };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const error = new Error(
    `P2P final friends did not converge for ${stableSamples} consecutive samples within ${timeoutMs}ms`,
  );
  error.snapshot = latest;
  error.comparison = comparison;
  throw error;
}
