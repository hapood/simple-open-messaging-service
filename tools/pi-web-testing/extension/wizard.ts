import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { CURSOR_MARKER, Input, truncateToWidth } from '@earendil-works/pi-tui';
import {
  endpoint,
  validateDeployment,
} from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';

type NodeConfig = {
  edge: string;
  admin: string;
  service: string;
  domain: string;
  account: string;
};
export type Deployment = {
  mode: 'quick' | 'full';
  nodes: Record<string, NodeConfig>;
};

// Delegate editing and IME to Pi's Input; render only a mask, never its raw value.
export async function passwordInput(
  ctx: ExtensionContext,
  title: string,
): Promise<string | undefined> {
  if (ctx.mode !== 'tui')
    throw new Error('Credential entry requires interactive Pi TUI.');
  return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
    const input = new Input();
    input.onSubmit = (value) => {
      if (value.length) done(value);
    };
    input.onEscape = () => done(undefined);
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        return [
          title,
          `> ${'*'.repeat(Math.min(input.getValue().length, 40))}${input.focused ? CURSOR_MARKER : ''} `,
          'Enter to confirm; Escape to cancel.',
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        input.handleInput(data);
        tui.requestRender();
      },
      invalidate() {
        input.invalidate();
      },
    };
  });
}

async function field(
  ctx: ExtensionContext,
  title: string,
  fallback?: string,
  check?: (value: string) => unknown,
): Promise<string | undefined> {
  for (;;) {
    const value = await ctx.ui.input(
      title,
      fallback ? `Default: ${fallback}` : undefined,
    );
    if (value === undefined) return undefined;
    const result = value.trim() || fallback;
    if (!result) {
      ctx.ui.notify('A value is required.', 'warning');
      continue;
    }
    try {
      check?.(result);
      return result;
    } catch {
      ctx.ui.notify(
        'Invalid value. Use an HTTP(S) URL without credentials, query or fragment.',
        'warning',
      );
    }
  }
}

export async function collectCredentials(
  ctx: ExtensionContext,
  deployment: Deployment,
) {
  const credentials: Record<string, string> = {};
  for (const [key, node] of Object.entries(deployment.nodes)) {
    const password = await passwordInput(
      ctx,
      `${key}: Admin password (${node.account})`,
    );
    if (password === undefined) return undefined;
    credentials[key] = password;
  }
  return credentials;
}

export async function collectDeployment(
  ctx: ExtensionContext,
): Promise<Deployment | undefined> {
  if (ctx.mode !== 'tui')
    throw new Error('Run npm run pi:webtest in an interactive terminal.');
  const selection = await ctx.ui.select('Browser acceptance scope', [
    '1 Full acceptance — three nodes',
    '2 Main workflows — two nodes',
  ]);
  if (!selection) return undefined;
  const mode = selection.startsWith('1') ? 'full' : 'quick';
  const nodes: Record<string, NodeConfig> = {};
  for (const key of mode === 'quick'
    ? ['alpha', 'bravo']
    : ['alpha', 'bravo', 'charlie']) {
    const edge = await field(ctx, `${key}: SOMS Web URL`, undefined, endpoint);
    if (!edge) return undefined;
    const service = await field(
      ctx,
      `${key}: backend service base URL (not /api/v1)`,
      edge,
      endpoint,
    );
    if (!service) return undefined;
    const admin = await field(
      ctx,
      `${key}: Admin console URL`,
      new URL('/admin/', edge).href,
      endpoint,
    );
    if (!admin) return undefined;
    // Web/service hostnames are not necessarily the federation identity domain.
    const domain = await field(
      ctx,
      `${key}: actual federation identity domain (confirm in Admin settings)`,
    );
    if (!domain) return undefined;
    const account = await field(ctx, `${key}: Admin username`, 'admin');
    if (!account) return undefined;
    nodes[key] = { edge, service, admin, domain, account };
  }
  const deployment = {
    mode,
    nodes: validateDeployment(mode, nodes),
  } as Deployment;
  if (
    !(await ctx.ui.confirm(
      'Authorize browser acceptance',
      `${JSON.stringify(deployment, null, 2)}\n\nConfirm these are authorized test deployments. Allow dedicated test accounts, relationships, groups, and uploads. Existing business data, database resets, credential changes, service restarts and source changes are NOT authorized.`,
    ))
  )
    return undefined;
  return deployment;
}
