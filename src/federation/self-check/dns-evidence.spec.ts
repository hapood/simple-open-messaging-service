import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CNAME_DEPTH, resolveDnsEvidence } from './dns-evidence.js';

const dns = vi.hoisted(() => ({
  cname: vi.fn(),
  v4: vi.fn(),
  v6: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({
  resolveCname: dns.cname,
  resolve4: dns.v4,
  resolve6: dns.v6,
}));
const code = (name: string) => Object.assign(new Error(name), { code: name });
beforeEach(() => {
  vi.clearAllMocks();
  dns.v4.mockResolvedValue(['203.0.113.10']);
  dns.v6.mockRejectedValue(code('ENODATA'));
  dns.cname.mockRejectedValue(code('ENODATA'));
});

describe('resolveDnsEvidence', () => {
  it('returns the plain answer when no CNAME record exists', async () => {
    const view = await resolveDnsEvidence('edge.example.net');
    expect(view).toEqual({
      host: 'edge.example.net',
      v4: ['203.0.113.10'],
      v6: [],
      cnameChain: [],
      errors: { v6: 'ENODATA' },
    });
    expect(dns.cname).toHaveBeenCalledExactlyOnceWith('edge.example.net');
    expect(dns.v4).toHaveBeenCalledExactlyOnceWith('edge.example.net');
  });
  it('treats an empty CNAME answer set as terminal', async () => {
    dns.cname.mockResolvedValueOnce([]);
    const view = await resolveDnsEvidence('edge.example.net');
    expect(view.cnameChain).toEqual([]);
    expect(view.errors).toEqual({ v6: 'ENODATA' });
  });
  it('follows a chain hop by hop and resolves the final name', async () => {
    dns.cname
      .mockResolvedValueOnce(['relay.example.net'])
      .mockResolvedValueOnce(['edge.ddns.example']);
    dns.v4.mockResolvedValue(['198.51.100.7']);
    const view = await resolveDnsEvidence('edge.example.net');
    expect(view.cnameChain).toEqual([
      { name: 'edge.example.net', targets: ['relay.example.net'] },
      { name: 'relay.example.net', targets: ['edge.ddns.example'] },
    ]);
    expect(view.host).toBe('edge.ddns.example');
    expect(view.v4).toEqual(['198.51.100.7']);
    expect(dns.v4).toHaveBeenCalledExactlyOnceWith('edge.ddns.example');
  });
  it('breaks a CNAME loop and reports it verbatim', async () => {
    dns.cname.mockImplementation(async (name: string) =>
      name === 'a.example.net' ? ['b.example.net'] : ['a.example.net'],
    );
    const view = await resolveDnsEvidence('a.example.net');
    expect(view.cnameChain).toEqual([
      { name: 'a.example.net', targets: ['b.example.net'] },
      { name: 'b.example.net', targets: ['a.example.net'] },
    ]);
    expect(view.errors.chain).toBe('CNAME_LOOP');
    expect(dns.v4).toHaveBeenCalledExactlyOnceWith('b.example.net');
  });
  it('stops at the depth cap instead of trusting an endless chain', async () => {
    dns.cname.mockImplementation(async (name: string) => [`hop-${name}`]);
    const view = await resolveDnsEvidence('start.example.net');
    expect(view.cnameChain).toHaveLength(MAX_CNAME_DEPTH);
    expect(view.errors.chain).toBe('CNAME_DEPTH_EXCEEDED');
    expect(dns.cname).toHaveBeenCalledTimes(MAX_CNAME_DEPTH);
  });
  it('keeps a mid-chain resolver failure verbatim and still resolves both families', async () => {
    dns.cname.mockRejectedValueOnce(code('ESERVFAIL'));
    dns.v6.mockResolvedValue(['2001:db8::1']);
    const view = await resolveDnsEvidence('edge.example.net');
    expect(view.cnameChain).toEqual([]);
    expect(view.errors).toEqual({ chain: 'ESERVFAIL' });
    expect(view.v6).toEqual(['2001:db8::1']);
  });
});
