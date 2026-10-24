import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  assertBrowserAction,
  createRun,
  decideRun,
  finishRun,
  loadRun,
  pauseRun,
  recordCase,
  registerCases,
  progressSummary,
  saveRun,
  resolveDeploymentIdentity,
} from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';
import { localOperationBlockReason } from './local-operation-policy';
import { recoverTestError } from './test-error-recovery';
import {
  loadLocalConfig,
  localConfigPath,
  matchesDeployment,
  saveLocalConfig,
} from './local-config';
import { redactSecrets } from '../../../test/browser-e2e/infrastructure/driver-secrets.mjs';
import {
  collectCredentials,
  collectDeployment,
  type Deployment,
} from './wizard';

type RunState = ReturnType<typeof createRun>;
export function installAcceptance(
  pi: ExtensionAPI,
  stopDriver: (reason: string) => Promise<void>,
) {
  let run: RunState | undefined;
  let credentials: Record<string, string> = {};
  let configuring = false;
  const root = (cwd: string) =>
    join(cwd, 'test-results/browser-e2e/acceptance');
  const clean = (text: string) =>
    redactSecrets(text, Object.values(credentials));
  const persist = () => {
    if (run) saveRun(run.directory, run.state);
  };
  const summary = () =>
    run
      ? { directory: run.directory, ...run.state }
      : { phase: 'unconfigured' };
  const prompt = () => {
    if (!run) return;
    pi.sendUserMessage(
      `/skill:web-testing Execute this authorized acceptance run: ${JSON.stringify(summary())}. First read the selected plan and perform preflight. Use webtest_run for progress and all pauses. No driver/shared-harness or product edits without a new explicit operator confirmation. Correct invocation errors and temporary-step mistakes using webtest_run recover with diagnostic evidence, without an operator dialog. Never use a shell or another browser client to bypass a pause.`,
      { expandPromptTemplates: true },
    );
  };
  async function setup(
    ctx: ExtensionContext,
    resumeId?: string,
    options?: { quiet?: boolean },
  ) {
    if (configuring) throw new Error('A wizard is already open.');
    if (ctx.mode !== 'tui')
      throw new Error('The acceptance wizard requires interactive Pi TUI.');
    configuring = true;
    try {
      if (
        run &&
        !(await ctx.ui.confirm(
          'Replace active run?',
          'The current driver will close. Its artifacts and profiles will be retained.',
        ))
      )
        return;
      const restored = resumeId
        ? loadRun(root(ctx.cwd), resumeId.trim())
        : undefined;
      let saved: Awaited<ReturnType<typeof loadLocalConfig>>;
      try {
        saved = await loadLocalConfig(ctx.cwd);
      } catch {
        if (
          !(await ctx.ui.confirm(
            'Replace unreadable local configuration?',
            'The saved test settings could not be read or validated. Re-enter the settings to replace them. Existing settings and the active run remain unchanged if setup is cancelled.',
          ))
        )
          return;
      }
      let reuse = false;
      if (saved) {
        const choice = await ctx.ui.select(
          `Saved browser test configuration (${saved.deployment.mode})\n${Object.entries(
            saved.deployment.nodes,
          )
            .map(
              ([key, node]) =>
                `${key}: Web ${node.edge}\nAdmin ${node.admin}\nUsername ${node.account}`,
            )
            .join(
              '\n',
            )}\nUsing this configuration authorizes dedicated test fixtures and routine local testing, not source changes or resets.`,
          ['Use saved configuration', 'Modify saved configuration'],
        );
        if (!choice) return;
        reuse = choice.startsWith('Use');
      }
      const deployment =
        reuse && saved
          ? saved.deployment
          : saved || !restored
            ? await collectDeployment(ctx)
            : ({
                mode: restored.state.mode,
                nodes: restored.state.nodes,
              } as Deployment);
      if (!deployment) return;
      const nextCredentials =
        reuse && saved
          ? saved.credentials
          : await collectCredentials(ctx, deployment);
      if (!nextCredentials) return;
      const nextConfig = {
        version: 1 as const,
        deployment,
        credentials: nextCredentials,
      };
      if (
        restored &&
        !matchesDeployment(nextConfig, {
          mode: restored.state.mode,
          nodes: restored.state.nodes,
        } as Deployment)
      )
        throw new Error(
          'Shared configuration does not match the restored run. Use the original endpoints/account or start a new run with /webtest. No credentials or run state were changed.',
        );
      if (
        restored &&
        !saved &&
        !(await ctx.ui.confirm(
          'Resume authorized test deployment?',
          `${JSON.stringify(deployment, null, 2)}\nSave these settings as the shared local test configuration? Revalidate identity and fixtures before continuing.`,
        ))
      )
        return;
      await saveLocalConfig(ctx.cwd, nextConfig);
      await stopDriver('acceptance deployment changed');
      const previous = run;
      credentials = nextCredentials;
      run =
        restored ?? createRun(root(ctx.cwd), deployment.mode, deployment.nodes);
      if (previous && previous !== run && previous.state.phase === 'running') {
        pauseRun(previous.state, {
          kind: 'UNCLASSIFIED',
          summary: 'Run replaced by another configuration',
          evidence:
            'Operator opened another run. Revalidate environment and fixtures before resuming.',
        });
        saveRun(previous.directory, previous.state);
      }
      if (!restored) {
        // Fresh run starts running immediately.
      } else if (run.state.phase === 'paused') {
        const issue = run.state.issues.at(-1);
        if (issue) issue.decision = undefined;
      } else {
        pauseRun(run.state, {
          kind: 'UNCLASSIFIED',
          summary: 'Resume preflight required',
          evidence:
            'Process/session changed. Verify deployment, profiles and fixtures before retrying.',
        });
      }
      persist();
      pi.appendEntry('webtest-run', { id: run.state.id });
      ctx.ui.setStatus('webtest', `${run.state.mode}: ${run.state.id}`);
      ctx.ui.notify(
        `Configuration: ${localConfigPath(ctx.cwd)}\nRun documents: ${run.directory}`,
        'info',
      );
      if (!options?.quiet) prompt();
    } finally {
      configuring = false;
    }
  }
  async function decide(ctx: ExtensionContext) {
    if (!run || run.state.phase !== 'paused')
      throw new Error('No paused issue.');
    if (ctx.mode !== 'tui')
      throw new Error('Operator confirmation requires interactive Pi TUI.');
    const issue = run.state.issues.at(-1);
    if (!issue) throw new Error('Paused run has no issue record.');
    const options = [
      'Retry after verification',
      'Skip and preserve gap/defect',
      'Stop run',
    ];
    if (issue.proposal?.trim())
      options.push('Authorize ONLY the proposed repair (remain paused)');
    const choice = await ctx.ui.select(
      `${issue.kind}: ${issue.summary}\n${issue.evidence}\nProposed repair: ${issue.proposal || 'none'}`,
      options,
    );
    if (!choice) return;
    const decision = choice.startsWith('Retry')
      ? 'retry'
      : choice.startsWith('Skip')
        ? 'skip'
        : choice.startsWith('Stop')
          ? 'stop'
          : 'repair';
    decideRun(run.state, decision);
    persist();
  }
  pi.registerFlag('webtest-wizard', {
    type: 'boolean',
    default: false,
    description: 'Start the acceptance setup wizard in interactive mode.',
  });
  pi.registerCommand('webtest', {
    description:
      'Configure two-node quick or three-node full browser acceptance',
    handler: async (_args, ctx) => setup(ctx),
  });
  pi.registerCommand('webtest-status', {
    description: 'Show current acceptance progress document',
    handler: async (_args, ctx) => {
      ctx.ui.notify(JSON.stringify(summary(), null, 2), 'info');
    },
  });
  pi.registerCommand('webtest-resume', {
    description: 'Resume acceptance by run ID using shared local test settings',
    handler: async (id, ctx) => {
      if (!id.trim()) {
        ctx.ui.notify('Usage: /webtest-resume RUN_ID', 'warning');
        return;
      }
      await setup(ctx, id);
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!pi.getFlag('webtest-wizard') || ctx.mode !== 'tui') return;
    // Session entries retain only the progress run ID. Deployment settings and
    // credentials are shared across sessions in the local test configuration.
    const last = [...ctx.sessionManager.getEntries()]
      .reverse()
      .find(
        (entry) =>
          entry.type === 'custom' &&
          (entry as { customType?: string }).customType === 'webtest-run',
      ) as { data?: { id?: string } } | undefined;
    if (last?.data?.id) {
      try {
        await setup(ctx, last.data.id, { quiet: true });
        const issue = run?.state.issues.at(-1);
        if (run?.state.phase === 'paused' && issue && !issue.decision)
          await decide(ctx);
      } catch {
        ctx.ui.notify(
          'Could not restore this run with the shared configuration. Check local settings and the run ID, then use /webtest-resume; /webtest starts a new run.',
          'error',
        );
      }
      return;
    }
    await setup(ctx);
  });
  pi.registerTool(
    defineTool({
      name: 'webtest_run',
      label: 'Acceptance progress',
      executionMode: 'sequential',
      description:
        'Persist acceptance scope, assertion-backed results, resume notes and issues. pause writes an issue before asking the operator; decision asks the operator for a paused driver failure. recover resumes only an unclassified browser-command failure diagnosed as an argument or temporary-step mistake, with evidence, without a dialog; it never authorizes shared-harness/product edits. record requires id, title and outcome. Never pass credentials or OTPs. Use register with up to 200 {id,title} cases per batch to expand matrices as NOT RUN before testing; existing results are preserved. register and record return compact summaries; status returns full state.',
      parameters: Type.Object({
        action: Type.Union(
          [
            'status',
            'register',
            'record',
            'pause',
            'decision',
            'recover',
            'checkpoint',
            'finish',
          ].map((value) => Type.Literal(value)),
        ),
        cases: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.String({ pattern: '^[a-zA-Z0-9_.-]{1,100}$' }),
                title: Type.String({ minLength: 1, maxLength: 500 }),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 200 },
          ),
        ),
        id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        outcome: Type.Optional(
          Type.Union(
            [
              'NOT RUN',
              'PASS',
              'BUG',
              'BLOCKED',
              'SKIPPED',
              'NOT VERIFIED',
            ].map((value) => Type.Literal(value)),
          ),
        ),
        kind: Type.Optional(
          Type.Union(
            [
              'PRODUCT_BUG',
              'DRIVER_MISMATCH',
              'ENVIRONMENT',
              'UNCLASSIFIED',
            ].map((value) => Type.Literal(value)),
          ),
        ),
        evidence: Type.Optional(Type.String()),
        proposal: Type.Optional(Type.String()),
        scope: Type.Optional(
          Type.Union([
            Type.Literal('arguments'),
            Type.Literal('temporary-step'),
          ]),
        ),
        path: Type.Optional(Type.String()),
        next: Type.Optional(Type.String()),
      }),
      async execute(_id, raw, _signal, _update, ctx) {
        if (!run) throw new Error('Run /webtest first.');
        // Defense in depth only. Do not submit any secret to this tool in the first place.
        const params = JSON.parse(
          JSON.stringify(raw, (_key, value) =>
            typeof value === 'string' ? clean(value) : value,
          ),
        ) as typeof raw;
        let registration: ReturnType<typeof registerCases> | undefined;
        if (params.action === 'register') {
          registration = registerCases(run.state, params.cases ?? []);
        } else if (params.action === 'record') {
          if (!params.id || !params.title || !params.outcome)
            throw new Error('record requires id, title and outcome.');
          recordCase(run.state, {
            id: params.id,
            title: params.title,
            outcome: params.outcome,
            evidence: params.evidence || '',
          });
          persist();
          if (run.state.phase === 'paused') await decide(ctx);
        } else if (params.action === 'pause') {
          if (!params.kind || !params.title || !params.evidence)
            throw new Error(
              'pause requires kind, title, evidence and an optional concrete repair proposal.',
            );
          pauseRun(run.state, {
            kind: params.kind,
            summary: params.title,
            evidence: params.evidence,
            proposal: params.proposal,
            caseId: params.id,
          });
          persist();
          await decide(ctx);
        } else if (params.action === 'decision') await decide(ctx);
        else if (params.action === 'recover') {
          recoverTestError(run.state, params);
        } else if (params.action === 'checkpoint') {
          if (!params.next?.trim())
            throw new Error(
              'checkpoint requires resume/fixture/cleanup notes in next.',
            );
          run.state.next = params.next;
          run.state.checkpoint = params.next;
        } else if (params.action === 'finish') finishRun(run.state);
        persist();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                ['register', 'record', 'recover'].includes(params.action)
                  ? {
                      directory: run.directory,
                      ...progressSummary(run.state),
                      ...(registration ? { registration } : {}),
                      ...(params.action === 'record'
                        ? { caseId: params.id }
                        : {}),
                    }
                  : summary(),
                null,
                2,
              ),
            },
          ],
          details: { directory: run.directory },
        };
      },
    }),
  );
  // Gate decisions, not individual keystrokes or routine local commands.
  // Trusted shells/steps remain subject to the Skill; this hook is not an OS sandbox.
  pi.on('tool_call', async (event) => {
    // Progress/status and pause/decision tools must remain usable even when a
    // local-operation policy fails. Do not evaluate that policy for other tools.
    if (!['bash', 'edit', 'write'].includes(event.toolName)) return;
    const path = 'path' in event.input ? event.input.path : undefined;
    const reason = localOperationBlockReason(run?.state, event.toolName, path);
    if (reason) return { block: true, reason };
  });
  return {
    configuration() {
      if (!run) return undefined;
      return {
        directory: run.directory,
        deploymentFile: join(run.directory, 'run.json'),
        credentials,
      };
    },
    acceptIdentity(node: string, domain: string) {
      if (!run) return;
      resolveDeploymentIdentity(run.state.nodes, node, domain);
      persist();
    },
    assertAction(action: string) {
      assertBrowserAction(run?.state, action);
    },
    driverFailed(message: string) {
      if (!run || run.state.phase !== 'running') return;
      pauseRun(run.state, {
        kind: 'UNCLASSIFIED',
        summary: 'Browser command failed; classify before continuing',
        evidence: clean(message),
        failureSource: 'browser-command',
      });
      persist();
    },
    async shutdown() {
      if (run?.state.phase === 'running') {
        pauseRun(run.state, {
          kind: 'UNCLASSIFIED',
          summary: 'Session ended before acceptance completed',
          evidence:
            'Resume with /webtest-resume and revalidate state; retained profiles are not proof of identity.',
        });
        persist();
      }
      credentials = {};
    },
  };
}
