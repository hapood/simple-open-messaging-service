import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NetworkInspectionService,
  isPublicAddress,
} from './network-inspection.service.js';
const mocks = vi.hoisted(() => ({ networkInterfaces: vi.fn() }));
vi.mock('node:os', () => ({ networkInterfaces: mocks.networkInterfaces }));
afterEach(() => vi.unstubAllEnvs());
describe('local network facts', () => {
  it('reports process-visible interfaces and explicit runtime without probing', () => {
    vi.stubEnv('SOMS_RUNTIME', 'docker');
    mocks.networkInterfaces.mockReturnValue({
      eth0: [
        {
          address: '172.20.0.2',
          family: 'IPv4',
          internal: false,
          cidr: '172.20.0.2/16',
        },
      ],
    });
    expect(new NetworkInspectionService().local()).toMatchObject({
      runtime: 'docker',
      interfaces: [{ name: 'eth0', family: 4, scope: 'private' }],
    });
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    'bad',
  ])('rejects non-public %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '2606:4700:4700::1111'])('accepts public %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
});
