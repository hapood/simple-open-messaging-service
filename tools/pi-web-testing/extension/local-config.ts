import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { validateDeployment } from '../../../test/browser-e2e/infrastructure/acceptance-run.mjs';
import type { Deployment } from './wizard';

export type LocalTestConfig = {
  version: 1;
  deployment: Deployment;
  credentials: Record<string, string>;
};

export function localConfigPath(cwd: string): string {
  return join(cwd, 'test/browser-e2e/.local/config.json');
}

function validate(value: unknown): LocalTestConfig {
  const config = value as Partial<LocalTestConfig> | null;
  if (
    !config ||
    config.version !== 1 ||
    !config.deployment ||
    !config.credentials ||
    typeof config.credentials !== 'object'
  )
    throw new Error(
      'Invalid local browser test configuration. Reconfigure it through /webtest.',
    );
  const deployment = {
    mode: config.deployment.mode,
    nodes: validateDeployment(config.deployment.mode, config.deployment.nodes),
  } as Deployment;
  const keys = Object.keys(deployment.nodes).sort();
  if (
    Object.keys(config.credentials).sort().join() !== keys.join() ||
    keys.some(
      (key) =>
        typeof config.credentials![key] !== 'string' ||
        !config.credentials![key].length,
    )
  )
    throw new Error(
      'Local browser test configuration requires one non-empty password per configured node.',
    );
  return {
    version: 1,
    deployment,
    credentials: Object.fromEntries(
      keys.map((key) => [key, config.credentials![key]]),
    ),
  };
}

export async function loadLocalConfig(
  cwd: string,
): Promise<LocalTestConfig | undefined> {
  let text: string;
  try {
    text = await readFile(localConfigPath(cwd), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      'Cannot read local browser test configuration. Check file permissions.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(
      'Invalid local browser test configuration JSON. Reconfigure it through /webtest.',
    );
  }
  const config = validate(value);
  await chmod(localConfigPath(cwd), 0o600);
  return config;
}

export async function saveLocalConfig(
  cwd: string,
  value: LocalTestConfig,
): Promise<void> {
  const config = validate(value);
  const directory = join(cwd, 'test/browser-e2e/.local');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = localConfigPath(cwd);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

// A shared credential must never be applied to a different restored deployment.
export function matchesDeployment(
  config: LocalTestConfig,
  deployment: Deployment,
): boolean {
  if (config.deployment.mode !== deployment.mode) return false;
  const left = config.deployment.nodes;
  const right = deployment.nodes;
  return (
    Object.keys(left).sort().join() === Object.keys(right).sort().join() &&
    Object.keys(right).every((key) => {
      const a = left[key];
      const b = right[key];
      return (
        ['edge', 'admin', 'service', 'account'].every(
          (field) => a[field as keyof typeof a] === b[field as keyof typeof b],
        ) &&
        (!a.domain || !b.domain || a.domain === b.domain)
      );
    })
  );
}
