import { describe, expect, it } from 'vitest';
import {
  composeScalar,
  DeploymentModeState,
  defaultsForMode,
  deploymentIssues,
  initialDeployment,
} from './compose-generator';

describe('deployment configuration validation', () => {
  const valid = {
    ...initialDeployment,
    domain: 'example.com',
    dataDir: './data',
    webDomain: 'soms.example.com',
    adminPassword: 'admin-password-123',
    dnsToken: 'test-token',
  };
  it('requires one registrable domain using public suffix rules', () => {
    expect(
      deploymentIssues({ ...valid, webDomain: 'app.other.net' }),
    ).toContain('webDomain');
    expect(
      deploymentIssues({ ...valid, lanDomain: 'lan.other.net' }),
    ).toContain('lanDomain');
    expect(
      deploymentIssues({
        ...valid,
        domain: 'id.example.co.uk',
        webDomain: 'app.example.co.uk',
        lanDomain: 'lan.example.co.uk',
      }),
    ).toEqual([]);
    expect(
      deploymentIssues({
        ...valid,
        domain: 'id.example.co.uk',
        webDomain: 'app.other.co.uk',
      }),
    ).toContain('webDomain');
  });
  it('validates required fields before export', () => {
    // domain, adminPassword, and dnsToken are remaining required fields (webDomain is optional, dataDir defaults to ./data)
    expect(deploymentIssues(initialDeployment)).toEqual([
      'domain',
      'adminPassword',
      'dnsToken',
    ]);
    expect(deploymentIssues(valid)).toEqual([]);
    expect(deploymentIssues({ ...valid, webDomain: '' })).toEqual([]);
    expect(deploymentIssues({ ...valid, dataDir: '' })).toContain('dataDir');
    expect(deploymentIssues({ ...valid, adminPassword: 'admin' })).toEqual([]);
  });
  it('fixes public ports and sets appropriate admin access default per mode', () => {
    expect(defaultsForMode('public')).toEqual({
      port: 7667,
      adminAccess: 'public',
      certMode: 'alpn',
    });
    expect(defaultsForMode('nas')).toEqual({
      port: 7667,
      adminAccess: 'lan',
      certMode: 'dns',
    });
    expect(initialDeployment.adminAccess).toBe('lan');
    expect(deploymentIssues({ ...valid, mode: 'public', port: 443 })).toContain(
      'publicPort',
    );
    expect(
      deploymentIssues({ ...valid, mode: 'public', port: 7668 }),
    ).toContain('publicPort');
    expect(deploymentIssues({ ...valid, mode: 'nas', port: 7668 })).toEqual([]);
  });
  it('keeps host-port and admin policy settings independent across tabs', () => {
    const state = new DeploymentModeState();
    const nas = { ...valid, port: 8888, adminAccess: 'public' as const };
    let current = state.switch(nas, 'public');
    expect(current).toMatchObject({
      mode: 'public',
      port: 7667,
      adminAccess: 'public',
    });
    current = state.switch({ ...current, adminAccess: 'lan' }, 'nas');
    expect(current).toMatchObject({
      mode: 'nas',
      port: 8888,
      adminAccess: 'public',
    });
    expect(state.switch(current, 'public').adminAccess).toBe('lan');
  });
  it('requires credentials matching chosen DNS provider', () => {
    expect(
      deploymentIssues({ ...valid, dnsProvider: 'cloudflare', dnsToken: '' }),
    ).toContain('dnsToken');
    expect(
      deploymentIssues({
        ...valid,
        dnsProvider: 'alidns',
        aliyunKeyId: '',
        aliyunKeySecret: 'secret',
      }),
    ).toContain('aliyunKeyId');
    expect(
      deploymentIssues({
        ...valid,
        dnsProvider: 'tencentcloud',
        tencentSecretId: 'id',
        tencentSecretKey: '',
      }),
    ).toContain('tencentSecretKey');
    expect(
      deploymentIssues({
        ...valid,
        dnsProvider: 'alidns',
        aliyunKeyId: 'test-id',
        aliyunKeySecret: 'test-secret',
      }),
    ).toEqual([]);
  });
  it('rejects URL-shaped domains and invalid ports', () => {
    expect(
      deploymentIssues({ ...valid, domain: 'https://example.com' }),
    ).not.toEqual([]);
    for (const port of [0, 65536, 1.5, NaN])
      expect(deploymentIssues({ ...valid, port })).not.toEqual([]);
  });
  it('validates certMode rules (ALPN skips DNS token, rejects lanDomain, requires public)', () => {
    const publicAlpn = {
      ...valid,
      mode: 'public' as const,
      port: 7667,
      certMode: 'alpn' as const,
      dnsToken: '',
    };
    expect(deploymentIssues(publicAlpn)).toEqual([]);
    expect(
      deploymentIssues({ ...publicAlpn, lanDomain: 'lan.example.com' }),
    ).toContain('lanDomainRequiresDns');
    expect(deploymentIssues({ ...publicAlpn, mode: 'nas' as const })).toContain(
      'certMode',
    );
  });
  it('escapes YAML and Compose independently', () => {
    expect(composeScalar('hello$token')).toBe('"hello$$token"');
    expect(JSON.parse(composeScalar('quote"\nnext'))).toBe('quote"\nnext');
  });
});
