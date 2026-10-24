import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { Writable } from 'node:stream';
import { installAcceptance } from './acceptance';
import { assertLoginNode } from './driver-command';
import { Type } from '@earendil-works/pi-ai';
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

const DRIVER_PATH = 'test/browser-e2e/driver.mjs';
const DEFAULT_STEP_DIRECTORY = '/tmp/soms-browser-e2e/steps';
const DEFAULT_ARTIFACT_DIRECTORY = '/tmp/soms-browser-e2e';
const DEFAULT_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 30 * 1024;
const MAX_RESULT_LINES = 500;
import { readFrontendStatus } from '../../../test/browser-e2e/infrastructure/frontend-status.mjs';

type DriverResponse = {
  id: number | null;
  ok: boolean;
  data?: unknown;
  error?: string;
};

type PendingCommand = {
  resolve: (response: DriverResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type FrontendService = 'web' | 'admin';
type FrontendStatus = {
  service: FrontendService;
  state: 'building' | 'success' | 'failure';
  sessionId?: string | null;
  buildId: number;
  observerPid?: number | null;
  childPid?: number | null;
  pid: number | null;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  diagnostics: string[];
};

const BrowserDriverParameters = Type.Object({
  action: Type.Union([
    Type.Literal('status'),
    Type.Literal('preflight'),
    Type.Literal('open'),
    Type.Literal('inspect'),
    Type.Literal('adminLogin'),
    Type.Literal('issueOtp'),
    Type.Literal('userLogin'),
    Type.Literal('eval'),
    Type.Literal('shot'),
    Type.Literal('errors'),
    Type.Literal('traceStart'),
    Type.Literal('traceStop'),
    Type.Literal('closeUser'),
    Type.Literal('resetUser'),
    Type.Literal('close'),
    Type.Literal('frontendStatus'),
    Type.Literal('frontendWait'),
    Type.Literal('frontendLogs'),
  ]),
  user: Type.Optional(
    Type.String({
      description: 'Persistent browser profile name, such as alice-alpha.',
    }),
  ),
  target: Type.Optional(
    Type.Union([Type.Literal('playground'), Type.Literal('federation')], {
      description:
        'Environment for open. Required for new profiles; existing profiles retain their target.',
    }),
  ),
  node: Type.Optional(
    Type.Union(
      [Type.Literal('alpha'), Type.Literal('bravo'), Type.Literal('charlie')],
      {
        description:
          'Required for adminLogin, issueOtp, and userLogin, even for an existing profile. Pass the explicit selected deployment alias; never infer it from a profile name.',
      },
    ),
  ),
  account: Type.Optional(
    Type.String({ description: 'Lab account used by OTP login helpers.' }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        'Optional URL within the selected target. The driver enforces approved deployment origins.',
    }),
  ),
  viewport: Type.Optional(
    Type.Object({
      width: Type.Integer({ minimum: 240, maximum: 3840 }),
      height: Type.Integer({ minimum: 240, maximum: 2160 }),
    }),
  ),
  script: Type.Optional(
    Type.String({
      description:
        'Absolute path to a trusted .mjs step module inside this repository or /tmp/soms-browser-e2e/steps.',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        'Safe artifact name for screenshots or traces: letters, digits, underscores, and hyphens.',
    }),
  ),
  clear: Type.Optional(
    Type.Boolean({ description: 'Clear captured errors after reading them.' }),
  ),
  services: Type.Optional(
    Type.Array(Type.Union([Type.Literal('web'), Type.Literal('admin')]), {
      minItems: 1,
      uniqueItems: true,
      description:
        'Frontend services to inspect or wait for. Defaults to both web and admin.',
    }),
  ),
  after: Type.Optional(
    Type.String({
      description:
        'For frontendWait, require a build started at or after this ISO timestamp.',
    }),
  ),
  webBuildId: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        'For frontendWait, require a Web build ID greater than this value.',
    }),
  ),
  adminBuildId: Type.Optional(
    Type.Integer({
      minimum: 0,
      description:
        'For frontendWait, require an Admin build ID greater than this value.',
    }),
  ),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description: 'Number of trailing log lines to return. Defaults to 100.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1_000,
      maximum: 300_000,
      description: 'Command timeout. Defaults to 120000 ms.',
    }),
  ),
});

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent !== '..' &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent)
  );
}

function assertEvalScript(cwd: string, script: string | undefined): string {
  if (!script) {
    throw new Error('The eval action requires an absolute script path.');
  }
  if (!isAbsolute(script) || !script.endsWith('.mjs')) {
    throw new Error('Eval scripts must be absolute .mjs paths.');
  }

  const resolvedScript = resolve(script);
  const stepDirectory = process.env.BROWSER_STEP_DIR || DEFAULT_STEP_DIRECTORY;
  if (
    !isWithin(cwd, resolvedScript) &&
    !isWithin(stepDirectory, resolvedScript)
  ) {
    throw new Error(
      `Eval scripts must be inside the repository or ${stepDirectory}.`,
    );
  }
  return resolvedScript;
}

function artifactDirectory(): string {
  return process.env.BROWSER_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIRECTORY;
}

async function frontendStatus(
  services: FrontendService[],
): Promise<
  Record<FrontendService, FrontendStatus & { processRunning: boolean }>
> {
  const entries = await Promise.all(
    services.map(
      async (service) => [service, await readFrontendStatus(service)] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<
    FrontendService,
    FrontendStatus & { processRunning: boolean }
  >;
}

async function waitForFrontend(
  services: FrontendService[],
  options: {
    after?: string;
    webBuildId?: number;
    adminBuildId?: number;
    timeoutMs: number;
    signal: AbortSignal;
  },
): Promise<
  Record<FrontendService, FrontendStatus & { processRunning: boolean }>
> {
  const after = options.after ? Date.parse(options.after) : undefined;
  if (options.after && Number.isNaN(after)) {
    throw new Error('frontendWait after must be a valid ISO timestamp.');
  }
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (options.signal.aborted) throw new Error('Frontend wait aborted.');
    try {
      const statuses = await frontendStatus(services);
      let complete = true;
      for (const service of services) {
        const status = statuses[service];
        if (!status.processRunning) {
          throw new Error(
            `${service} HMR process ${String(status.pid)} is not running.`,
          );
        }
        const minimumBuildId =
          service === 'web' ? options.webBuildId : options.adminBuildId;
        const isNewEnough =
          (minimumBuildId === undefined || status.buildId > minimumBuildId) &&
          (after === undefined || Date.parse(status.startedAt) >= after);
        if (!isNewEnough || status.state === 'building') {
          complete = false;
          continue;
        }
        if (status.state === 'failure') {
          throw new Error(
            `${service} HMR build ${status.buildId} failed: ${status.diagnostics.join('\n') || 'see frontend logs'}`,
          );
        }
      }
      if (complete) return statuses;
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        / HMR build \d+ failed:/.test(error.message)
      ) {
        throw error;
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Frontend build did not complete within ${options.timeoutMs} ms.${lastError instanceof Error ? ` Last status: ${lastError.message}` : ''}`,
  );
}

async function frontendLogs(
  services: Array<FrontendService | 'caddy'>,
  lineCount: number,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    services.map(async (service) => {
      const path = join(artifactDirectory(), 'logs', `${service}.log`);
      try {
        const lines = (await readFile(path, 'utf8')).split('\n');
        return [
          service,
          lines
            .slice(-lineCount - 1)
            .join('\n')
            .trimEnd(),
        ] as const;
      } catch (error) {
        return [
          service,
          `[Log unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}]`,
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

export default function browserTestingExtension(pi: ExtensionAPI) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let childCwd: string | undefined;
  let readyPromise: Promise<void> | undefined;
  let nextCommandId = 1;
  const pending = new Map<number, PendingCommand>();
  const stderrTail: string[] = [];

  function rejectPending(error: Error): void {
    for (const command of pending.values()) {
      clearTimeout(command.timer);
      command.reject(error);
    }
    pending.clear();
  }

  async function stopDriver(reason: string): Promise<void> {
    const processToStop = child;
    if (!processToStop) return;

    child = undefined;
    childCwd = undefined;
    readyPromise = undefined;
    rejectPending(new Error(`Browser driver stopped: ${reason}`));

    if (processToStop.exitCode === null && processToStop.signalCode === null) {
      processToStop.kill('SIGTERM');
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          if (
            processToStop.exitCode === null &&
            processToStop.signalCode === null
          ) {
            processToStop.kill('SIGKILL');
          }
          resolveStop();
        }, 5_000);
        timer.unref();
        processToStop.once('exit', () => {
          clearTimeout(timer);
          resolveStop();
        });
      });
    }
  }

  const acceptance = installAcceptance(pi, stopDriver);

  async function ensureDriver(cwd: string): Promise<void> {
    if (child && childCwd === cwd && readyPromise) {
      return readyPromise;
    }
    if (child) {
      await stopDriver('working directory changed');
    }

    const absoluteDriverPath = join(cwd, DRIVER_PATH);
    const config = acceptance.configuration();
    const spawned = spawn(process.execPath, [absoluteDriverPath], {
      cwd,
      env: {
        ...process.env,
        ...(config
          ? {
              BROWSER_DEPLOYMENT_FILE: config.deploymentFile,
              BROWSER_ARTIFACT_DIR: config.directory,
              BROWSER_PROFILE_DIR: join(config.directory, 'profiles'),
            }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    // Secrets are transferred through a private inherited pipe, never persisted.
    const credentialPipe = spawned.stdio[3] as Writable | null;
    credentialPipe?.on('error', () => {
      /* Startup/exit handlers report transport failure. */
    });
    credentialPipe?.end(JSON.stringify(config?.credentials ?? {}));
    child = spawned;
    childCwd = cwd;
    stderrTail.length = 0;

    readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      const startupTimer = setTimeout(() => {
        rejectReady(
          new Error(
            `Browser driver did not become ready within ${STARTUP_TIMEOUT_MS} ms.`,
          ),
        );
        void stopDriver('startup timeout');
      }, STARTUP_TIMEOUT_MS);

      const stdout = createInterface({ input: spawned.stdout });
      stdout.on('line', (line) => {
        let response: DriverResponse;
        try {
          response = JSON.parse(line) as DriverResponse;
        } catch {
          return;
        }

        if (response.id === 0 && response.ok) {
          clearTimeout(startupTimer);
          resolveReady();
          return;
        }
        if (typeof response.id !== 'number') return;

        const command = pending.get(response.id);
        if (!command) return;
        pending.delete(response.id);
        clearTimeout(command.timer);
        command.resolve(response);
      });

      const stderr = createInterface({ input: spawned.stderr });
      stderr.on('line', (line) => {
        stderrTail.push(line.slice(0, 1_000));
        if (stderrTail.length > 20) stderrTail.shift();
      });

      spawned.once('error', (error) => {
        clearTimeout(startupTimer);
        rejectReady(error);
      });

      spawned.once('exit', (code, signal) => {
        clearTimeout(startupTimer);
        if (child === spawned) {
          child = undefined;
          childCwd = undefined;
          readyPromise = undefined;
        }
        const diagnostics = stderrTail.length
          ? `\n${stderrTail.join('\n')}`
          : '';
        const error = new Error(
          `Browser driver exited (code=${String(code)}, signal=${String(signal)}).${diagnostics}`,
        );
        rejectReady(error);
        rejectPending(error);
      });
    });

    return readyPromise;
  }

  async function sendCommand(
    cwd: string,
    input: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<DriverResponse> {
    await ensureDriver(cwd);
    if (!child) throw new Error('Browser driver is unavailable.');
    if (signal.aborted) throw new Error('Browser command aborted.');

    const id = nextCommandId++;
    const response = new Promise<DriverResponse>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            `Browser command ${String(input.action)} timed out after ${timeoutMs} ms.`,
          ),
        );
        void stopDriver('command timeout');
      }, timeoutMs);
      pending.set(id, { resolve: resolveResponse, reject, timer });
    });

    const abort = () => {
      const command = pending.get(id);
      if (!command) return;
      pending.delete(id);
      clearTimeout(command.timer);
      command.reject(new Error('Browser command aborted.'));
      void stopDriver('command aborted');
    };
    signal.addEventListener('abort', abort, { once: true });

    try {
      child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
      return await response;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  const browserDriverTool = defineTool({
    name: 'browser_driver',
    label: 'Project browser driver',
    executionMode: 'sequential',
    description:
      'Control the project-specific persistent Playwright driver. It supports isolated user/admin profiles, lab login helpers, accessibility snapshots, trusted repository-local step modules, screenshots, traces, and captured browser errors. Read the web-testing skill before using it. Commands sharing state must be called sequentially.',
    parameters: BrowserDriverParameters,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const operationSignal = signal ?? new AbortController().signal;
      acceptance.assertAction(params.action);
      if (
        acceptance.configuration() &&
        ['frontendStatus', 'frontendWait', 'frontendLogs'].includes(
          params.action,
        )
      )
        throw new Error(
          'Configured deployment acceptance uses HTTP/UI preflight, not local HMR files.',
        );
      if (params.action === 'frontendStatus') {
        const services = params.services ?? ['web', 'admin'];
        const data = await frontendStatus(services);
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: { action: params.action, services },
        };
      }
      if (params.action === 'frontendWait') {
        const services = params.services ?? ['web', 'admin'];
        const data = await waitForFrontend(services, {
          after: params.after,
          webBuildId: params.webBuildId,
          adminBuildId: params.adminBuildId,
          timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: operationSignal,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
          details: { action: params.action, services },
        };
      }
      if (params.action === 'frontendLogs') {
        const services = params.services ?? ['web', 'admin'];
        const data = await frontendLogs(
          [...services, 'caddy'],
          params.lines ?? 100,
        );
        const serialized = JSON.stringify(data, null, 2);
        return {
          content: [{ type: 'text', text: serialized }],
          details: { action: params.action, services },
        };
      }

      const script =
        params.action === 'eval'
          ? assertEvalScript(ctx.cwd, params.script)
          : params.script;

      const command = Object.fromEntries(
        Object.entries({ ...params, script }).filter(
          ([key, value]) => key !== 'timeoutMs' && value !== undefined,
        ),
      );
      let response: DriverResponse;
      try {
        assertLoginNode(params);
        response = await sendCommand(
          ctx.cwd,
          command,
          params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          operationSignal,
        );
        if (!response.ok)
          throw new Error(response.error || 'Browser driver command failed.');
        if (params.action === 'adminLogin' && params.node) {
          const identity = response.data as { domain?: string };
          if (identity.domain)
            acceptance.acceptIdentity(params.node, identity.domain);
        }
      } catch (error) {
        acceptance.driverFailed(
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }

      const serialized = JSON.stringify(response.data, null, 2);
      const truncation = truncateHead(serialized, {
        maxBytes: MAX_RESULT_BYTES,
        maxLines: MAX_RESULT_LINES,
      });
      let resultText = truncation.content;
      let fullOutputPath: string | undefined;

      if (truncation.truncated) {
        const artifactRoot =
          process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
        const outputDirectory = join(artifactRoot, 'pi-tool-results');
        await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
        fullOutputPath = join(
          outputDirectory,
          `${Date.now()}-${params.action}.json`,
        );
        await writeFile(fullOutputPath, serialized, {
          encoding: 'utf8',
          mode: 0o600,
        });
        resultText += `\n\n[Result truncated. Full output: ${fullOutputPath}]`;
      }

      return {
        content: [{ type: 'text', text: resultText }],
        details: {
          action: params.action,
          fullOutputPath,
          truncated: truncation.truncated,
        },
      };
    },
  });

  pi.registerTool(browserDriverTool);

  pi.on('session_shutdown', async () => {
    await stopDriver('Pi session shutdown');
    await acceptance.shutdown();
  });
}
