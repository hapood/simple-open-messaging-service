import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function endpoint(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an HTTP(S) URL without credentials, query, or fragment.',
    );
  return url.href.replace(/\/$/, '') + '/';
}

export function deploymentNode(
  externalUrl,
  internalAdminUrl = '',
  account = 'admin',
) {
  const edge = endpoint(externalUrl);
  const adminUrl = internalAdminUrl.trim();
  const admin = adminUrl
    ? endpoint(
        new URL(adminUrl).pathname === '/'
          ? new URL('/admin/', adminUrl).href
          : adminUrl,
      )
    : new URL('/admin/', edge).href;
  return {
    edge,
    admin,
    service: edge,
    domain: '',
    account: account.trim() || 'admin',
  };
}

export function resolveDeploymentIdentity(nodes, key, rawDomain) {
  if (!Object.hasOwn(nodes, key)) throw new Error('Unknown deployment node.');
  const domain =
    typeof rawDomain === 'string' ? rawDomain.trim().toLowerCase() : '';
  if (!domain || !/^[a-z0-9.-]+(?::\d+)?$/.test(domain))
    throw new Error(
      `${key}: Admin did not report a valid federation identity domain.`,
    );
  if (nodes[key].domain && nodes[key].domain !== domain)
    throw new Error(
      `${key}: deployment identity changed; verify configuration before continuing.`,
    );
  if (
    Object.entries(nodes).some(
      ([other, node]) => other !== key && node.domain === domain,
    )
  )
    throw new Error(
      'Configured entrances resolve to the same federation identity.',
    );
  nodes[key].domain = domain;
  return domain;
}

export function validateDeployment(mode, input) {
  if (!['quick', 'full'].includes(mode))
    throw new Error('Select quick or full.');
  const keys =
    mode === 'quick' ? ['alpha', 'bravo'] : ['alpha', 'bravo', 'charlie'];
  if (Object.keys(input).sort().join() !== [...keys].sort().join())
    throw new Error(`${mode} requires exactly ${keys.length} nodes.`);
  const nodes = Object.fromEntries(
    keys.map((key) => {
      const node = input[key];
      const domain = String(node.domain ?? '')
        .trim()
        .toLowerCase();
      if (domain && !/^[a-z0-9.-]+(?::\d+)?$/.test(domain))
        throw new Error(
          `${key}: enter the actual federation identity domain, not a URL.`,
        );
      return [
        key,
        {
          edge: endpoint(node.edge),
          admin: endpoint(node.admin),
          service: endpoint(node.service),
          domain,
          account: String(node.account || 'admin').trim(),
        },
      ];
    }),
  );
  for (const field of ['edge', 'admin', 'domain']) {
    const values = Object.values(nodes)
      .map((node) =>
        field === 'domain' ? node[field] : new URL(node[field]).origin,
      )
      .filter(Boolean);
    if (new Set(values).size !== values.length)
      throw new Error(`Nodes must have distinct ${field} identities/origins.`);
  }
  return nodes;
}

export const quickCases = [
  ['Q0', 'Environment, identity, isolated accounts and login'],
  ['Q1', 'Local and federated friendship lifecycle'],
  ['Q2', 'Local and federated group membership lifecycle'],
  ['Q3', 'Group settings, announcements and permissions'],
  ['Q4', 'Direct and group message/media/file matrix'],
  ['Q5', 'Personal and group avatar lifecycle matrix'],
  ['Q6', 'Reload, reconnect, retained history and cleanup'],
];

export function initialCases(mode) {
  return (
    mode === 'quick'
      ? quickCases
      : [
          ['0', 'Environment and account setup'],
          ['1', 'Administrator workflows'],
          ['2', 'Local relationships'],
          ['3', 'Federated relationships'],
          ['4', 'Local groups'],
          ['5', 'Federated groups and cut matrices'],
          ['6', 'Receipts and withdrawal'],
          ['7', 'Quotes and forwarding'],
          ['8', 'System events'],
          ['9', 'Media and files'],
          ['10', 'Calls'],
          ['12', 'Announcements'],
          ['A-I', 'Additional feature and identity matrices'],
          ['VIEWPORT', 'Viewport and visual review matrix'],
          ['CLEANUP', 'Fixture cleanup'],
        ]
  ).map(([id, title]) => ({ id, title, outcome: 'NOT RUN', evidence: '' }));
}

export function createRun(root, mode, input) {
  const nodes = validateDeployment(mode, input);
  const id = `${Date.now()}-${randomUUID()}`;
  const directory = join(resolve(root), id);
  const state = {
    version: 1,
    id,
    mode,
    nodes,
    phase: 'running',
    createdAt: new Date().toISOString(),
    cases: initialCases(mode),
    issues: [],
    next: 'Run preflight; expand every selected plan matrix into assertion-sized cases before mutations.',
  };
  saveRun(directory, state);
  return { directory, state };
}

function atomic(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
const cell = (value) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
export function saveRun(directory, state) {
  mkdirSync(join(directory, 'bugs'), { recursive: true, mode: 0o700 });
  state.updatedAt = new Date().toISOString();
  // JSON is authoritative. Markdown is a replaceable projection, never a second state owner.
  atomic(join(directory, 'run.json'), JSON.stringify(state, null, 2) + '\n');
  atomic(
    join(directory, 'progress.md'),
    `# Browser acceptance run ${state.id}\n\nMode: ${state.mode}\n\nState: ${state.phase}\n\nUpdated: ${state.updatedAt}\n\n| Case | Scope | Outcome | Evidence |\n| --- | --- | --- | --- |\n${state.cases.map((item) => `| ${cell(item.id)} | ${cell(item.title)} | ${item.outcome} | ${cell(item.evidence)} |`).join('\n')}\n\n## Issues\n\n${state.issues.map((issue) => `- [${issue.id}](bugs/${issue.id}.md): ${cell(issue.kind)} — ${cell(issue.summary)} (${issue.decision || 'awaiting operator'})`).join('\n')}\n`,
  );
  atomic(
    join(directory, 'handoff.md'),
    `# Resume ${state.id}\n\nState: ${state.phase}\n\nNext action / fixture and cleanup notes:\n\n${state.next}\n\n## Last fixture / cleanup checkpoint\n\n${state.checkpoint || 'No checkpoint recorded yet.'}\n\nRevalidate deployment identity, version, profiles and fixture state before continuing. Shared machine-local test settings can be reused after process restart; never put credentials in run records. Historical PASS is not evidence for a changed deployment.\n`,
  );
  for (const issue of state.issues)
    atomic(
      join(directory, 'bugs', `${issue.id}.md`),
      `# ${issue.kind}: ${issue.summary}\n\nCase: ${issue.caseId || 'preflight'}\n\n${issue.evidence}\n\nProposed change / next action:\n\n${issue.proposal || 'Diagnose before proposing a change.'}\n\nResolution: ${issue.decision || 'pending operator decision'}\n`,
    );
}

export function loadRun(root, id) {
  if (!/^\d+-[a-f0-9-]{36}$/.test(id))
    throw new Error('Use a run ID, not a path.');
  const directory = join(resolve(root), id);
  const state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
  if (
    state.version !== 1 ||
    state.id !== id ||
    !Array.isArray(state.cases) ||
    !Array.isArray(state.issues)
  )
    throw new Error('Unsupported run record.');
  state.nodes = validateDeployment(state.mode, state.nodes);
  return { directory, state };
}

/**
 * Longest common dotted prefix across a registration batch. The leaf segment
 * is never consumed, so a batch of sibling assertions keeps its shared parent
 * as the active round; mixed batches fall back to the chapter prefix.
 */
export function roundPrefixOf(ids) {
  const segments = ids.map((id) => id.split('.'));
  const depth = Math.min(...segments.map((parts) => parts.length - 1));
  const round = [];
  for (let index = 0; index < depth; index += 1) {
    const segment = segments[0][index];
    if (!segments.every((parts) => parts[index] === segment)) break;
    round.push(segment);
  }
  return round.join('.') || segments[0][0];
}

export function registerCases(state, items) {
  if (state.phase !== 'running')
    throw new Error('Resolve the pause with the operator first.');
  if (!Array.isArray(items) || items.length < 1 || items.length > 200)
    throw new Error('register requires between 1 and 200 cases.');
  const seen = new Set();
  const additions = [];
  for (const item of items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(item.id) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 500 ||
      Object.keys(item).some((key) => !['id', 'title'].includes(key))
    )
      throw new Error(
        'Each registration requires only a valid id and title (1-500 characters).',
      );
    if (seen.has(item.id)) throw new Error(`Duplicate case ID: ${item.id}`);
    seen.add(item.id);
    const existing = state.cases.find((entry) => entry.id === item.id);
    if (existing && existing.title !== item.title)
      throw new Error(`Existing case title differs: ${item.id}`);
    if (!existing)
      additions.push({ ...item, outcome: 'NOT RUN', evidence: '' });
  }
  // Validate the complete batch before mutating; re-registration never resets results.
  state.cases.push(...additions);
  // Registering a round manifest switches the status round to that manifest.
  state.roundCaseIds = items.map((item) => item.id);
  state.round = roundPrefixOf(state.roundCaseIds);
  return {
    requested: items.length,
    added: additions.length,
    preserved: items.length - additions.length,
    round: state.round,
  };
}

export function progressSummary(state) {
  const outcomes = {};
  for (const item of state.cases)
    outcomes[item.outcome] = (outcomes[item.outcome] ?? 0) + 1;
  return {
    id: state.id,
    phase: state.phase,
    caseCount: state.cases.length,
    outcomes,
    issueCount: state.issues.length,
  };
}

export function recordCase(state, item) {
  if (state.phase !== 'running')
    throw new Error('Resolve the pause with the operator first.');
  if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(item.id))
    throw new Error('Invalid case ID.');
  if (
    !['NOT RUN', 'PASS', 'BUG', 'BLOCKED', 'SKIPPED', 'NOT VERIFIED'].includes(
      item.outcome,
    )
  )
    throw new Error('Invalid outcome.');
  if (item.outcome !== 'NOT RUN' && !item.evidence?.trim())
    throw new Error('Evidence or a concrete reason is required.');
  const existing = state.cases.find((entry) => entry.id === item.id);
  if (existing) Object.assign(existing, item);
  else state.cases.push(item);
  if (['BUG', 'BLOCKED'].includes(item.outcome))
    pauseRun(state, {
      kind: item.outcome === 'BUG' ? 'PRODUCT_BUG' : 'ENVIRONMENT',
      caseId: item.id,
      summary: item.title,
      evidence: item.evidence,
    });
}

export function pauseRun(state, issue) {
  if (
    !['PRODUCT_BUG', 'DRIVER_MISMATCH', 'ENVIRONMENT', 'UNCLASSIFIED'].includes(
      issue.kind,
    )
  )
    throw new Error('Invalid issue kind.');
  const previous = state.issues.at(-1);
  const classifyPending =
    state.phase === 'paused' &&
    previous?.kind === 'UNCLASSIFIED' &&
    !previous.decision;
  state.phase = 'paused';
  const entry = classifyPending
    ? Object.assign(previous, issue, {
        evidence: `${previous.evidence}\n\nClassification:\n${issue.evidence}`,
      })
    : { ...issue, id: `issue-${state.issues.length + 1}` };
  if (!classifyPending) state.issues.push(entry);
  state.next = `Paused at ${entry.id}: ${entry.summary}. Await an explicit operator decision.`;
  return entry;
}

export function decideRun(state, decision) {
  if (!['continue', 'stop'].includes(decision))
    throw new Error('Invalid decision.');
  const issue = state.issues.at(-1);
  if (state.phase !== 'paused' || !issue) throw new Error('No paused issue.');
  issue.decision = decision;
  if (decision === 'stop') {
    state.phase = 'stopped';
    state.next =
      'Stopped by operator; retain evidence and document remaining cleanup.';
    return;
  }
  // The operator's continue approval also approves a repair proposal recorded
  // on this issue; authorization ends at the next pause.
  state.phase = 'running';
  state.next = issue.proposal?.trim()
    ? `Operator approved continuing with ${issue.id}'s recorded proposal: perform only its scoped edits, run focused checks, then rerun the failed assertion; never infer PASS from a repair.`
    : 'Revalidate the environment and retry the blocked case, or record SKIPPED with a reason and continue with the next independent case; never infer PASS.';
}

export function assertBrowserAction(state, action) {
  if (
    state &&
    state.phase !== 'running' &&
    ![
      'status',
      'inspect',
      'errors',
      'shot',
      'traceStop',
      'close',
      'closeUser',
    ].includes(action)
  )
    throw new Error(
      'Run paused/stopped. Record the issue and request an operator decision; do not bypass the driver.',
    );
}

export function finishRun(state) {
  if (state.phase !== 'running') throw new Error('Run is not running.');
  if (state.cases.some((item) => item.outcome === 'NOT RUN'))
    throw new Error(
      'Unfinished cases remain; record a reason instead of claiming completion.',
    );
  state.phase = 'completed';
  state.next =
    'Execution finished. Report exact tested scope and all gaps; do not equate completion with PASS.';
}
