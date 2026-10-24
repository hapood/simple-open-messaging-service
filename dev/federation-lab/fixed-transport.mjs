import { Agent, fetch } from 'undici';
import { lookup } from 'node:dns';

/** Install a disposable local transport before app initialization. Only connection
 * targets are fixed: HTTP authority, signatures and TLS identity remain domain-based.
 * No production configuration or DNS fallback participates in this transport. */
export function installFixedFederationTransport(discovery, targets) {
  const routes = new Map();
  for (const [domain, value] of Object.entries(targets)) {
    const target = new URL(value);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.pathname !== '/' ||
      target.search ||
      target.hash
    )
      throw new Error(`Invalid fixed federation target for ${domain}`);
    routes.set(domain, {
      base: `${target.protocol}//${domain}${target.port ? `:${target.port}` : ''}`,
      host: target.hostname.replace(/^\[|\]$/g, ''),
    });
  }
  const pools = new Map();
  const retiring = new Set();
  let stopped = false;
  const originalShutdown = discovery.onApplicationShutdown.bind(discovery);
  function routeFor(domain) {
    if (stopped) throw new Error('Fixed federation transport is shutting down');
    const route = routes.get(domain.toLowerCase());
    if (!route) throw new Error(`No fixed federation target for ${domain}`);
    return route;
  }
  function invalidate(domain) {
    const pool = pools.get(domain);
    pools.delete(domain);
    if (pool) {
      // Disposable hosts cancel obsolete streams instead of retaining old sockets.
      const pending = pool.destroy();
      retiring.add(pending);
      void pending.then(
        () => retiring.delete(pending),
        () => {},
      );
    }
  }
  discovery.resolveBase = async (domain) => routeFor(domain).base;
  discovery.refreshRoute = async (domain) => {
    routeFor(domain);
  };
  discovery.invalidateBase = (domain) => invalidate(domain.toLowerCase());
  discovery.invalidateAllRoutes = () => {
    for (const domain of pools.keys()) invalidate(domain);
  };
  discovery.request = async (url, init = {}) => {
    const parsed = new URL(url);
    const domain = parsed.hostname;
    const route = routeFor(domain);
    if (parsed.origin !== route.base)
      throw new Error(`Unexpected fixed federation authority for ${domain}`);
    let dispatcher = pools.get(domain);
    if (!dispatcher) {
      dispatcher = new Agent({
        connect: {
          servername: domain,
          // DNS lookup resolves only the injected target, never the logical domain.
          lookup: (_hostname, options, callback) => {
            lookup(route.host, options, callback);
          },
        },
      });
      pools.set(domain, dispatcher);
    }
    return fetch(parsed, { ...init, dispatcher, redirect: 'manual' });
  };
  discovery.onApplicationShutdown = async () => {
    stopped = true;
    discovery.invalidateAllRoutes();
    await Promise.all([...retiring, originalShutdown()]);
  };
}
