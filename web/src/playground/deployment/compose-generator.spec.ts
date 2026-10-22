import { describe, expect, it } from 'vitest';
import {
  composeScalar,
  defaultsForMode,
  deploymentIssues,
  initialDeployment,
} from './compose-generator';

describe('deployment configuration validation', () => {
  const valid = {
    ...initialDeployment,
    domain: 'example.com',
    webDomain: 'soms.example.com',
    adminPassword: 'admin-password-123',
    dnsToken: 'test-token',
  };
  it('validates required fields before export', () => {
    // initialDeployment now includes pre-generated databasePassword
    // domain, webDomain, adminPassword, and dnsToken are remaining required fields
    expect(deploymentIssues(initialDeployment)).toHaveLength(4);
    expect(deploymentIssues(valid)).toEqual([]);
  });
  it('fixes public ports and sets appropriate admin access default per mode', () => {
    expect(defaultsForMode('public')).toEqual({
      port: 7667,
      adminAccess: 'public',
    });
    expect(defaultsForMode('nas')).toEqual({ port: 7667, adminAccess: 'lan' });
    expect(initialDeployment.adminAccess).toBe('lan');
    expect(deploymentIssues({ ...valid, mode: 'public', port: 443 })).toContain(
      'publicPort',
    );
    expect(
      deploymentIssues({ ...valid, mode: 'public', port: 7668 }),
    ).toContain('publicPort');
    expect(deploymentIssues({ ...valid, mode: 'nas', port: 7668 })).toEqual([]);
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
  it('escapes YAML and Compose independently', () => {
    expect(composeScalar('hello$token')).toBe('"hello$$token"');
    expect(JSON.parse(composeScalar('quote"\nnext'))).toBe('quote"\nnext');
  });
});
