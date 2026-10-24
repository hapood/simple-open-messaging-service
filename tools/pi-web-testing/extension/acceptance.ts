import { join, resolve } from 'node:path';
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
  saveRun,
} from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';
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
      `/skill:web-testing Execute this authorized acceptance run: ${JSON.stringify(summary())}. First read the selected plan and perform preflight. Use webtest_run for progress and all pauses. No driver or product edits without a new explicit operator confirmation. Never use a shell or another browser client to bypass a pause.`,
      { expandPromptTemplates: true },
    );
  };
  async function setup(ctx: ExtensionContext, resumeId?: string) {
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
      const deployment = restored
        ? ({
            mode: restored.state.mode,
            nodes: restored.state.nodes,
          } as Deployment)
        : await collectDeployment(ctx);
      if (!deployment) return;
      if (
        restored &&
        !(await ctx.ui.confirm(
          'Resume authorized test deployment?',
          `${JSON.stringify(deployment, null, 2)}\nRevalidate identity/build and fixture state before any mutation. Resume does not authorize source changes or reset operations.`,
        ))
      )
        return;
      const nextCredentials = await collectCredentials(ctx, deployment);
      if (!nextCredentials) return;
      await stopDriver('acceptance deployment changed');
      if (run && run.state.phase === 'running') {
        pauseRun(run.state, {
          kind: 'UNCLASSIFIED',
          summary: 'Run replaced by another configuration',
          evidence:
            'Operator opened another run. Revalidate environment and fixtures before resuming.',
        });
        persist();
      }
      credentials = nextCredentials;
      run =
        restored ?? createRun(root(ctx.cwd), deployment.mode, deployment.nodes);
      // A persisted repair decision never grants edit permission in another session.
      if (restored && run.state.phase !== 'paused') {
        pauseRun(run.state, {
          kind: 'UNCLASSIFIED',
          summary: 'Resume preflight required',
          evidence:
            'Process/session changed. Verify deployment, profiles and fixtures before retrying.',
        });
      } else if (restored) {
        const issue = run.state.issues.at(-1);
        if (issue) issue.decision = undefined;
      }
      persist();
      pi.appendEntry('webtest-run', { id: run.state.id });
      ctx.ui.setStatus('webtest', `${run.state.mode}: ${run.state.id}`);
      ctx.ui.notify(`Run documents: ${run.directory}`, 'info');
      prompt();
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
    description: 'Resume acceptance by run ID; re-enter credentials',
    handler: async (id, ctx) => {
      if (!id.trim()) {
        ctx.ui.notify('Usage: /webtest-resume RUN_ID', 'warning');
        return;
      }
      await setup(ctx, id);
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('webtest-wizard') && ctx.mode === 'tui') await setup(ctx);
  });
  pi.registerTool(
    defineTool({
      name: 'webtest_run',
      label: 'Acceptance progress',
      executionMode: 'sequential',
      description:
        'Persist acceptance scope, assertion-backed results, resume notes and issues. pause writes an issue before asking the operator; decision asks the operator for a paused driver failure. Never pass credentials or OTPs. Expand matrices with NOT RUN records before testing.',
      parameters: Type.Object({
        action: Type.Union(
          ['status', 'record', 'pause', 'decision', 'checkpoint', 'finish'].map(
            (value) => Type.Literal(value),
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
        if (params.action === 'record') {
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
        else if (params.action === 'checkpoint') {
          if (!params.next?.trim())
            throw new Error(
              'checkpoint requires resume/fixture/cleanup notes in next.',
            );
          run.state.next = params.next;
          run.state.checkpoint = params.next;
        } else if (params.action === 'finish') finishRun(run.state);
        persist();
        return {
          content: [{ type: 'text', text: JSON.stringify(summary(), null, 2) }],
          details: { directory: run.directory },
        };
      },
    }),
  );
  // Native gates complement the Skill. Shells and file writers require a fresh visible approval;
  // arbitrary shell commands cannot be classified safely by matching command strings.
  pi.on('tool_call', async (event, ctx) => {
    if (!run) return;
    if (['bash', 'edit', 'write'].includes(event.toolName)) {
      const path = 'path' in event.input ? event.input.path : undefined;
      const temporaryStep =
        event.toolName === 'write' &&
        typeof path === 'string' &&
        resolve(path).startsWith('/tmp/soms-browser-e2e/steps/') &&
        path.endsWith('.mjs') &&
        run.state.phase === 'running';
      if (temporaryStep) return;
      const issue = run.state.issues.at(-1);
      if (event.toolName !== 'bash' && issue?.decision !== 'repair')
        return {
          block: true,
          reason:
            'Source changes require a paused issue, a concrete proposal, and explicit operator repair approval.',
        };
      if (
        ctx.mode !== 'tui' ||
        !(await ctx.ui.confirm(
          'Authorize this local operation?',
          clean(
            `${event.toolName}: ${JSON.stringify(event.input)}\nDo not approve alternate browser clients or bypass paused acceptance. Repair approval applies only to the recorded proposal.`,
          ),
        ))
      )
        return { block: true, reason: 'Operation not authorized by operator.' };
    }
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
    assertAction(action: string) {
      assertBrowserAction(run?.state, action);
    },
    driverFailed(message: string) {
      if (!run || run.state.phase !== 'running') return;
      pauseRun(run.state, {
        kind: 'UNCLASSIFIED',
        summary: 'Browser command failed; classify before continuing',
        evidence: clean(message),
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
