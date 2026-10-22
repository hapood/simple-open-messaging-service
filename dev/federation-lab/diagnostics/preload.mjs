import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { loadavg } from 'node:os';
import pg from 'pg';

// Opt-in lab instrumentation. Never record credentials, bodies, or SQL text.
if (process.env.SOMS_DIAGNOSTICS_DIR) {
  mkdirSync(process.env.SOMS_DIAGNOSTICS_DIR, { recursive: true });
  const output = createWriteStream(
    join(process.env.SOMS_DIAGNOSTICS_DIR, `process-${process.pid}.jsonl`),
    { flags: 'a' },
  );
  let dropped = 0;
  const record = (value) => {
    if (output.destroyed || output.writableLength > 1024 * 1024) {
      dropped++;
      return;
    }
    output.write(
      JSON.stringify({
        time: new Date().toISOString(),
        pid: process.pid,
        node: process.env.SOMS_DOMAIN ?? 'runner',
        ...value,
      }) + '\n',
    );
  };
  output.on('error', (error) =>
    console.error(`[diagnostics] output failed: ${error.code}`),
  );
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let cpu = process.cpuUsage();
  let tick = performance.now();
  const pools = new Set();
  const connect = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = function (...args) {
    pools.add(this);
    const start = performance.now();
    const done = (error) => {
      const waitMs = performance.now() - start;
      if (waitMs >= 100 || error)
        record({
          type: 'pool_acquire',
          waitMs,
          failed: Boolean(error),
          total: this.totalCount,
          idle: this.idleCount,
          waiting: this.waitingCount,
        });
    };
    if (typeof args[0] === 'function') {
      const callback = args[0];
      args[0] = (...result) => {
        done(result[0]);
        callback(...result);
      };
      return connect.apply(this, args);
    }
    const result = connect.apply(this, args);
    result.then(() => done(), done);
    return result;
  };
  setInterval(() => {
    const now = performance.now();
    const usage = process.cpuUsage();
    record({
      type: 'runtime',
      intervalMs: now - tick,
      loopMaxMs: lag.max / 1e6,
      loopP99Ms: lag.percentile(99) / 1e6,
      cpuMs: (usage.user + usage.system - cpu.user - cpu.system) / 1000,
      rss: process.memoryUsage().rss,
      loadavg: loadavg(),
      dropped,
      pools: [...pools].map((pool) => ({
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      })),
    });
    cpu = usage;
    tick = now;
    lag.reset();
  }, 1000).unref();
  const requests = new WeakMap();
  channel('undici:request:create').subscribe(({ request }) => {
    requests.set(request, {
      started: performance.now(),
      method: request.method,
      origin: String(request.origin),
      path: request.path.split('?')[0],
    });
  });
  channel('undici:request:headers').subscribe(({ request, response }) => {
    const entry = requests.get(request);
    if (!entry) return;
    entry.headersMs = performance.now() - entry.started;
    entry.status = response.statusCode;
    for (let i = 0; i < response.headers.length; i += 2) {
      if (String(response.headers[i]).toLowerCase() === 'x-request-id')
        entry.requestId = String(response.headers[i + 1]);
    }
    record({ type: 'http_headers', ...entry, elapsedMs: entry.headersMs });
  });
  for (const [name, type] of [
    ['trailers', 'http_complete'],
    ['error', 'http_error'],
  ]) {
    channel(`undici:request:${name}`).subscribe(({ request }) => {
      const entry = requests.get(request);
      if (entry)
        record({
          type,
          ...entry,
          elapsedMs: performance.now() - entry.started,
        });
      requests.delete(request);
    });
  }
  record({ type: 'started' });
}
