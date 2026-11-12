import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  EdgeConfigError,
  parseEdgeConfig,
  renderCaddyfile,
} from '../src/edge/caddyfile-renderer.js';

/**
 * Container bootstrap CLI: renders the Caddyfile from the process environment. Invoked by
 * docker/supervisor.sh before the origin and Caddy start; a failure exits non-zero so the
 * container restart loop keeps the misconfiguration visible in `docker compose logs app`.
 */
function main(): void {
  const run = process.env.SOMS_RUN_DIR ?? '/tmp/soms';
  const caddyfile = process.env.CADDYFILE ?? `${run}/Caddyfile`;

  let rendered: string;
  let config;
  try {
    config = parseEdgeConfig(process.env);
    rendered = renderCaddyfile(config);
  } catch (error) {
    if (error instanceof EdgeConfigError) {
      process.stderr.write(`init: ERROR — ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  process.umask(0o077);
  mkdirSync(run, { recursive: true });
  mkdirSync(dirname(caddyfile), { recursive: true });
  writeFileSync(caddyfile, rendered, { mode: 0o600 });
  process.stderr.write(
    `init: OK — domain=${config.domain} web-domain=${config.webDomain || config.domain} lan-domain=${config.lanDomain || 'none'} mode=${config.tlsMode} cert-mode=${config.certMode} admin=${config.adminAccess}; wrote ${caddyfile}\n`,
  );
}

main();
