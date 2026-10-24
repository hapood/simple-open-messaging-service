import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadLocalConfig,
  localConfigPath,
  matchesDeployment,
  saveLocalConfig,
  type LocalTestConfig,
} from '../../tools/pi-web-testing/extension/local-config';

const fixture = (): LocalTestConfig => ({
  version: 1,
  deployment: {
    mode: 'quick',
    nodes: {
      alpha: {
        edge: 'https://a.test/',
        admin: 'https://admin-a.test/admin/',
        service: 'https://a.test/',
        domain: '',
        account: 'admin',
      },
      bravo: {
        edge: 'https://b.test/',
        admin: 'https://admin-b.test/admin/',
        service: 'https://b.test/',
        domain: '',
        account: 'admin',
      },
    },
  },
  credentials: {
    alpha: 'synthetic-test-secret-a',
    bravo: 'synthetic-test-secret-b',
  },
});

describe('shared machine-local browser test configuration', () => {
  it('saves one private configuration reusable across runs without per-run password files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soms-local-config-'));
    try {
      expect(await loadLocalConfig(root)).toBeUndefined();
      await saveLocalConfig(root, fixture());
      expect(localConfigPath(root)).toBe(
        join(root, 'test/browser-e2e/.local/config.json'),
      );
      expect(await loadLocalConfig(root)).toEqual(fixture());
      expect((await stat(localConfigPath(root))).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(localConfigPath(root)))).mode & 0o777).toBe(
        0o700,
      );
      await chmod(localConfigPath(root), 0o644);
      await loadLocalConfig(root);
      expect((await stat(localConfigPath(root))).mode & 0o777).toBe(0o600);
      const changed = fixture();
      changed.credentials.alpha = 'replacement-synthetic-secret';
      await saveLocalConfig(root, changed);
      expect((await loadLocalConfig(root))?.credentials.alpha).toBe(
        'replacement-synthetic-secret',
      );
      expect(
        await stat(join(root, 'test-results')).catch(() => undefined),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects incomplete credentials without overwriting saved configuration and never echoes malformed contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soms-local-config-'));
    try {
      await saveLocalConfig(root, fixture());
      const before = await readFile(localConfigPath(root), 'utf8');
      const missing = fixture();
      delete missing.credentials.bravo;
      await expect(saveLocalConfig(root, missing)).rejects.toThrow(
        'one non-empty password',
      );
      expect(await readFile(localConfigPath(root), 'utf8')).toBe(before);
      await writeFile(localConfigPath(root), '{ malformed-private-fixture');
      await expect(loadLocalConfig(root)).rejects.toThrow(
        'Invalid local browser test configuration JSON.',
      );
      try {
        await loadLocalConfig(root);
      } catch (error) {
        expect(String(error)).not.toContain('malformed-private-fixture');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('binds shared credentials to exact restored targets and known identity, not just node aliases', () => {
    const config = fixture();
    expect(matchesDeployment(config, fixture().deployment)).toBe(true);
    const changed = fixture().deployment;
    changed.nodes.alpha.admin = 'https://different.test/admin/';
    expect(matchesDeployment(config, changed)).toBe(false);
    changed.nodes.alpha = {
      ...config.deployment.nodes.alpha,
      account: 'another-admin',
    };
    expect(matchesDeployment(config, changed)).toBe(false);
    changed.nodes.alpha = {
      ...config.deployment.nodes.alpha,
      domain: 'a.test',
    };
    expect(matchesDeployment(config, changed)).toBe(true);
    config.deployment.nodes.alpha.domain = 'different.test';
    expect(matchesDeployment(config, changed)).toBe(false);
    expect(
      matchesDeployment(config, { ...fixture().deployment, mode: 'full' }),
    ).toBe(false);
  });
});
