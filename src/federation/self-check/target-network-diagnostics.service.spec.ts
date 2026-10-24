import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDiagnosticTarget,
  TargetNetworkDiagnosticsService,
} from './target-network-diagnostics.service.js';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  resolveSrv: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns/promises', () => ({
  Resolver: class {
    resolve4 = mocks.resolve4;
    resolve6 = mocks.resolve6;
    resolveSrv = mocks.resolveSrv;
    cancel = mocks.cancel;
  },
}));

describe('target diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    vi.clearAllMocks();
    mocks.resolve4.mockResolvedValue(['1.1.1.1']);
    mocks.resolve6.mockResolvedValue([]);
    mocks.resolveSrv.mockRejectedValue(
      Object.assign(new Error(), { code: 'ENODATA' }),
    );
    mocks.request.mockImplementation((_url, _opts, respond) => {
      const req = Object.assign(new EventEmitter(), {
        end: vi.fn(),
        destroy: vi.fn(),
      });
      req.end.mockImplementation(() => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 404,
          destroy: vi.fn(),
        });
        respond(res);
        res.emit('end');
      });
      return req;
    });
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    '',
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com?q=1',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::ffff:127.0.0.1]',
    'https://169.254.169.254',
  ])('rejects unsafe input %s', (input) =>
    expect(() => parseDiagnosticTarget(input)).toThrow(),
  );
  it('normalizes an explicit port and discards application paths', () => {
    expect(parseDiagnosticTarget('example.com:7668/admin').origin).toBe(
      'https://example.com:7668',
    );
  });
  it('does not probe until run, pins public addresses, and treats a non-federation website separately', async () => {
    const svc = new TargetNetworkDiagnosticsService();
    expect(mocks.request).not.toHaveBeenCalled();
    const report = await svc.run('example.com:7668');
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'https', status: 'ok' }),
        expect.objectContaining({ name: 'federation', status: 'skip' }),
      ]),
    );
    const [url, options] = mocks.request.mock.calls[0];
    expect(url.href).toBe('https://example.com:7668/.well-known/somfp');
    const callback = vi.fn();
    options.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(options.family).toBe(4);
    await expect(svc.run('other.example')).rejects.toMatchObject({
      status: 429,
    });
  });
  it('rejects mixed public/private DNS without making any HTTPS request', async () => {
    mocks.resolve6.mockResolvedValue(['::1']);
    const report = await new TargetNetworkDiagnosticsService().run(
      'example.com',
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'dns', status: 'fail' }),
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('tests both families with bounded fanout', async () => {
    mocks.resolve4.mockResolvedValue(['1.1.1.1', '8.8.8.8']);
    mocks.resolve6.mockResolvedValue(['2606:4700:4700::1111']);
    await new TargetNetworkDiagnosticsService().run('example.com');
    expect(mocks.request).toHaveBeenCalledTimes(3);
  });
  it('does not follow redirects', async () => {
    mocks.request.mockImplementation((_url, _opts, respond) => {
      const req = Object.assign(new EventEmitter(), {
        end: vi.fn(),
        destroy: vi.fn(),
      });
      req.end.mockImplementation(() => {
        const res = new EventEmitter();
        Object.assign(res, { statusCode: 302 });
        respond(res);
        res.emit('end');
      });
      return req;
    });
    const report = await new TargetNetworkDiagnosticsService().run(
      'example.com',
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'federation', status: 'warn' }),
    );
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled request and releases the concurrency guard', async () => {
    const destroy = vi.fn();
    mocks.request.mockReturnValue(
      Object.assign(new EventEmitter(), { end: vi.fn(), destroy }),
    );
    const pending = new TargetNetworkDiagnosticsService().run('example.com');
    await vi.advanceTimersByTimeAsync(7001);
    expect((await pending).checks).toContainEqual(
      expect.objectContaining({ name: 'https', status: 'fail' }),
    );
    expect(destroy).toHaveBeenCalled();
  });
});
