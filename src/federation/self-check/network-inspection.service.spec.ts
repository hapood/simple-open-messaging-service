import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { NetworkIpProbeDto } from '../../admin/admin-network.controller.js';
import {
  NetworkInspectionService,
  isPublicAddress,
} from './network-inspection.service.js';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  lookup: vi.fn(),
  networkInterfaces: vi.fn(),
}));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns', () => ({ lookup: mocks.lookup }));
vi.mock('node:os', () => ({ networkInterfaces: mocks.networkInterfaces }));

describe('NetworkInspectionService', () => {
  let req: EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let respond: (
    response: EventEmitter & {
      statusCode: number;
      destroy: ReturnType<typeof vi.fn>;
    },
  ) => void;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.request.mockReset();
    mocks.lookup.mockReset();
    req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    mocks.request.mockImplementation((_url, _options, callback) => {
      respond = callback;
      return req;
    });
    mocks.networkInterfaces.mockReturnValue({
      eth0: [
        {
          address: '172.20.0.2',
          family: 'IPv4',
          internal: false,
          cidr: '172.20.0.2/16',
        },
      ],
      lo: [{ address: '::1', family: 'IPv6', internal: true, cidr: '::1/128' }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const response = (statusCode = 200) =>
    Object.assign(new EventEmitter(), { statusCode, destroy: vi.fn() });

  it('reports process-visible interfaces and explicit runtime without probing', () => {
    vi.stubEnv('SOMS_RUNTIME', 'docker');
    const service = new NetworkInspectionService();
    expect(service.local()).toMatchObject({
      runtime: 'docker',
      interfaces: [
        { name: 'eth0', family: 4, scope: 'private' },
        { name: 'lo', family: 6, scope: 'loopback' },
      ],
    });
    vi.stubEnv('SOMS_RUNTIME', '');
    expect(service.local().runtime).toBe('unknown');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('pins family, returns source address, coalesces requests and caches for ten seconds', async () => {
    const service = new NetworkInspectionService();
    const pending = service.probe('ip-sb', 6);
    expect(service.probe('ip-sb', 6)).toBe(pending);
    expect(mocks.request).toHaveBeenCalledWith(
      'https://api-ipv6.ip.sb/ip',
      expect.objectContaining({ family: 6, agent: false }),
      expect.any(Function),
    );
    const socket = Object.assign(new EventEmitter(), {
      localAddress: 'fd00::2',
    });
    req.emit('socket', socket);
    socket.emit('connect');
    const res = response();
    respond(res);
    res.emit('data', Buffer.from('2606:4700:4700::1111\n'));
    res.emit('end');
    expect(await pending).toMatchObject({
      status: 'ok',
      family: 6,
      ip: '2606:4700:4700::1111',
      localAddress: 'fd00::2',
    });
    await service.probe('ip-sb', 6);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_001);
    const next = service.probe('ip-sb', 6);
    req.emit('error', Object.assign(new Error(), { code: 'EADDRNOTAVAIL' }));
    expect(await next).toMatchObject({ status: 'warn', code: 'EADDRNOTAVAIL' });
    expect(mocks.request).toHaveBeenCalledTimes(2);
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

  it('validates the DNS answer actually supplied to the socket', async () => {
    const pending = new NetworkInspectionService().probe('ipify', 4);
    mocks.lookup.mockImplementation((_host, _opts, cb) =>
      cb(null, '127.0.0.1', 4),
    );
    const callback = vi.fn();
    mocks.request.mock.calls[0][1].lookup('api.ipify.org', {}, callback);
    expect(callback.mock.calls[0][0].code).toBe('NON_PUBLIC_DESTINATION');
    req.emit('error', callback.mock.calls[0][0]);
    expect((await pending).code).toBe('NON_PUBLIC_DESTINATION');
  });

  it.each(['1.1.1.1', '<html>blocked</html>', 'fd00::1'])(
    'rejects wrong family or non-public/non-IP body %s',
    async (body) => {
      const pending = new NetworkInspectionService().probe('ip-sb', 6);
      const res = response();
      respond(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
      expect((await pending).code).toBe('INVALID_IP_RESPONSE');
    },
  );

  it('rejects redirects without following them', async () => {
    const pending = new NetworkInspectionService().probe('ident-me', 4);
    const res = response(302);
    respond(res);
    expect((await pending).code).toBe('HTTP_302');
    expect(req.destroy).toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it('bounds response bytes', async () => {
    const pending = new NetworkInspectionService().probe('ipify', 4);
    const res = response();
    respond(res);
    res.emit('data', Buffer.alloc(257));
    expect((await pending).code).toBe('RESPONSE_TOO_LARGE');
    expect(req.destroy).toHaveBeenCalled();
  });

  it('bounds the entire request including a stalled DNS lookup', async () => {
    const pending = new NetworkInspectionService().probe('ipify', 4);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).code).toBe('ETIMEDOUT');
    expect(req.destroy).toHaveBeenCalled();
  });

  it('rejects arbitrary provider IDs and invalid families at both boundaries', async () => {
    const service = new NetworkInspectionService();
    expect(() => service.probe('https://localhost' as never, 4)).toThrow();
    expect(() => service.probe('ipify', 5 as never)).toThrow();
    const dto = Object.assign(new NetworkIpProbeDto(), {
      source: 'ipify',
      family: 6,
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(
      await validate(Object.assign(dto, { source: 'localhost', family: '6' })),
    ).toHaveLength(2);
  });
});
