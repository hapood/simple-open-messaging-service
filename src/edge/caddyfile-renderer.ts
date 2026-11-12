/**
 * Runtime configuration renderer for the container's TLS edge. It validates the environment
 * injected by Compose and produces the self-contained Caddyfile used by the app container.
 * No deployment config is sourced as code and no generated environment/password files are
 * shared between containers.
 *
 * Provider-agnostic: `CADDY_DNS_DIRECTIVE` contains native Caddy `{env.KEY}` placeholders. DNS
 * modules resolve credentials from their process environment; the renderer never inserts
 * credential values. The ZeroSSL API key uses the same native placeholder mechanism and is
 * resolved when Caddy provisions the issuer.
 *
 * Every configuration problem throws {@link EdgeConfigError} with a precise message; the CLI
 * writes it to stderr (so it appears in `docker compose logs app`) and exits non-zero.
 */

/** Validation failure with the operator-facing message (mirrors the historic shell messages). */
export class EdgeConfigError extends Error {}

export type TlsMode = 'single-port' | 'standard' | 'disabled';
export type CertMode = 'dns' | 'alpn';
export type AdminAccess = 'public' | 'lan';

export interface EdgeConfig {
  domain: string;
  webDomain: string;
  lanDomain: string;
  tlsMode: TlsMode;
  certMode: CertMode;
  adminAccess: AdminAccess;
  /** Raw DNS provider directive; may embed native `{env.NAME}` references. */
  dnsDirective: string;
  acmeEmail: string;
  zerosslApiKeyConfigured: boolean;
  backendSocket: string;
  edgePort: number;
}

const BARE_DOMAIN = /^[A-Za-z0-9._-]+$/;
/** POSIX `[[:space:]]` restricted to the ASCII set the historic shell pattern accepted. */
const ASCII_WHITESPACE = /[ \t\n\r\f\v]/;

function die(message: string): never {
  throw new EdgeConfigError(message);
}

/** Registrable-domain (apex) of a bare hostname — last 2 labels. Used to enforce that
 * SOMS_LAN_DOMAIN shares SOMS_DOMAIN's apex (both are certified via ONE DNS-01 provider/zone).
 * Multi-label TLDs (co.uk) reduce accuracy; the common subdomain case is covered and operators
 * know their topology. */
export function apexOf(domain: string): string {
  const labels = domain.split('.');
  return labels.length >= 2 ? labels.slice(-2).join('.') : domain;
}

/** Whether a hostname is already matched by the identity site's exact host or one-label
 * wildcard. Example: SOMS_DOMAIN=example.com already covers chat.example.com via
 * *.example.com, so emitting a second Caddy site for SOMS_WEB_DOMAIN would be redundant.
 * A sibling of a subdomain is not covered. */
export function coveredByIdentitySite(
  candidate: string,
  domain: string,
): boolean {
  if (candidate === domain) return true;
  if (!candidate.endsWith(`.${domain}`)) return false;
  return !candidate.slice(0, -domain.length - 1).includes('.');
}

function optionalBareDomain(
  value: string | undefined,
  name: 'SOMS_WEB_DOMAIN' | 'SOMS_LAN_DOMAIN',
  domain: string,
): string {
  const value_ = value ?? '';
  if (!value_) return '';
  if (!BARE_DOMAIN.test(value_))
    die(
      `${name} must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '${value_}'`,
    );
  if (apexOf(domain) !== apexOf(value_)) {
    if (name === 'SOMS_LAN_DOMAIN') {
      die(
        `SOMS_LAN_DOMAIN ('${value_}' → ${apexOf(value_)}) must share SOMS_DOMAIN's registrable domain ('${domain}' → ${apexOf(domain)}) — both are certified via one DNS-01 provider/zone (CADDY_DNS_DIRECTIVE). Use a subdomain of the same apex.`,
      );
    }
    die(
      `SOMS_WEB_DOMAIN ('${value_}') must share SOMS_DOMAIN's registrable domain ('${domain}')`,
    );
  }
  return value_;
}

/** Validate the deployment environment and resolve all defaults into a concrete config. */
export function parseEdgeConfig(env: NodeJS.ProcessEnv): EdgeConfig {
  const domain = env.SOMS_DOMAIN ?? '';
  if (!domain) die('SOMS_DOMAIN is required');
  if (!BARE_DOMAIN.test(domain))
    die(
      `SOMS_DOMAIN must be a bare domain (letters/digits/dot/_/- only; no scheme/port/path): '${domain}'`,
    );

  const tlsMode = env.SOMS_TLS_MODE ?? '';
  if (
    tlsMode !== 'single-port' &&
    tlsMode !== 'standard' &&
    tlsMode !== 'disabled'
  )
    die(
      `SOMS_TLS_MODE must be one of: single-port | standard | disabled (got '${tlsMode || '<unset>'}')`,
    );

  const rawCertMode = env.CADDY_CERT_MODE ?? '';
  if (rawCertMode !== '' && rawCertMode !== 'dns' && rawCertMode !== 'alpn')
    die(
      `CADDY_CERT_MODE must be one of: alpn | dns (got '${rawCertMode || '<unset>'}')`,
    );
  let certMode: CertMode;
  if (rawCertMode) {
    certMode = rawCertMode;
  } else if (env.CADDY_DNS_DIRECTIVE) {
    certMode = 'dns';
  } else if (tlsMode === 'standard') {
    certMode = 'alpn';
  } else {
    certMode = 'dns';
  }

  // This image always runs Caddy as its only TLS edge and connects to the Node origin over
  // loopback HTTP. Direct Fastify TLS would make that upstream protocol (and the container
  // healthcheck) disagree with Node.
  if (env.TLS_CERT || env.TLS_KEY) {
    if (tlsMode === 'standard' || tlsMode === 'single-port')
      die(
        `conflicting TLS configuration: TLS_CERT/TLS_KEY cannot be used with Caddy automatic DNS-01 TLS (SOMS_TLS_MODE=${tlsMode}); remove TLS_CERT and TLS_KEY`,
      );
    die(
      'TLS_CERT and TLS_KEY are unsupported in the full Docker image because Caddy requires a plaintext loopback origin; remove TLS_CERT and TLS_KEY',
    );
  }

  // Admin area exposure. `public` (default) leaves /admin + /api/v1/admin open to all; `lan`
  // restricts both to private-range IPs (a @not_lan guard in the Caddyfile — see handlers()).
  // Backward-compatible: an existing .env without this var stays open.
  const rawAdminAccess = env.SOMS_ADMIN_ACCESS ?? 'public';
  if (rawAdminAccess !== 'public' && rawAdminAccess !== 'lan')
    die(
      `SOMS_ADMIN_ACCESS must be one of: public | lan (got '${env.SOMS_ADMIN_ACCESS ?? '<unset>'}')`,
    );

  const webDomain = optionalBareDomain(
    env.SOMS_WEB_DOMAIN,
    'SOMS_WEB_DOMAIN',
    domain,
  );
  const lanDomain = optionalBareDomain(
    env.SOMS_LAN_DOMAIN,
    'SOMS_LAN_DOMAIN',
    domain,
  );

  const acmeEmail = env.ACME_EMAIL ?? env.CADDY_ACME_EMAIL ?? '';
  let dnsDirective = '';
  if (tlsMode !== 'disabled') {
    if (certMode === 'alpn') {
      // ALPN validation answers the TLS-ALPN-01 challenge on standard port 443; private/LAN
      // domains cannot be certified that way (external ACME servers cannot reach them).
      if (tlsMode !== 'standard')
        die(
          'ALPN certificate validation (CADDY_CERT_MODE=alpn) requires standard port 443 (SOMS_TLS_MODE=standard)',
        );
      if (lanDomain)
        die(
          'SOMS_LAN_DOMAIN requires DNS-01 certificate validation (CADDY_CERT_MODE=dns); ALPN validation (port 443) cannot certify private/LAN domains',
        );
      if (
        acmeEmail &&
        (ASCII_WHITESPACE.test(acmeEmail) || /[{}]/.test(acmeEmail))
      )
        die(
          `ACME_EMAIL/CADDY_ACME_EMAIL must be a bare address without whitespace or braces: '${acmeEmail}'`,
        );
    } else {
      dnsDirective = env.CADDY_DNS_DIRECTIVE ?? '';
      if (!dnsDirective)
        die('CADDY_DNS_DIRECTIVE is required when TLS is enabled with DNS-01');
      // Validate native environment references without expanding secrets. Modules such as
      // Route 53 may also read credentials directly from their environment without explicit
      // placeholders.
      if (
        /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(dnsDirective) ||
        dnsDirective.includes('{$')
      )
        die(
          'CADDY_DNS_DIRECTIVE must use native {env.NAME} references, not {NAME} or {$NAME}',
        );
      const refs = new Set(
        [...dnsDirective.matchAll(/\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
          (m) => m[1],
        ),
      );
      for (const ref of refs)
        if (!env[ref])
          die(`CADDY_DNS_DIRECTIVE references {env.${ref}} but it is not set`);
    }
  }

  const backendSocket = env.SOMS_BACKEND_SOCKET ?? '';
  if (backendSocket && !/^\/[A-Za-z0-9/_.-]+$/.test(backendSocket))
    die('SOMS_BACKEND_SOCKET must be an absolute path without whitespace');

  const rawEdgePort = env.SOMS_EDGE_PORT ?? '7667';
  const edgePort = /^[0-9]+$/.test(rawEdgePort)
    ? Number.parseInt(rawEdgePort, 10)
    : 0;
  if (!(edgePort >= 1 && edgePort <= 65535))
    die('SOMS_EDGE_PORT must be 1-65535');

  return {
    domain,
    webDomain,
    lanDomain,
    tlsMode,
    certMode,
    adminAccess: rawAdminAccess as AdminAccess,
    dnsDirective,
    acmeEmail,
    zerosslApiKeyConfigured: Boolean(env.CADDY_ZEROSSL_API_KEY),
    backendSocket,
    edgePort,
  };
}

function tlsBlock(config: EdgeConfig): string {
  if (config.tlsMode === 'disabled') return '';
  if (config.certMode === 'alpn') {
    // A `tls <email>` argument declares an implicit issuer, which Caddy rejects next to
    // explicit `issuer` blocks; the email belongs inside the ACME issuer instead. Port 80
    // stays closed, so only the TLS-ALPN-01 challenge remains enabled. ZeroSSL requires its
    // API key as a positional argument and rejects challenge subdirectives; the native
    // {env.NAME} reference is resolved when Caddy provisions the issuer, keeping the key out
    // of the generated Caddyfile. The fallback issuer is emitted only when a key is set.
    const lines = [
      '\ttls {',
      '\t\tissuer acme {',
      '\t\t\tdisable_http_challenge',
    ];
    if (config.acmeEmail) lines.push(`\t\t\temail ${config.acmeEmail}`);
    lines.push('\t\t}');
    if (config.zerosslApiKeyConfigured)
      lines.push('\t\tissuer zerossl {env.CADDY_ZEROSSL_API_KEY}');
    lines.push('\t}');
    return lines.join('\n');
  }
  return `\ttls {\n\t\t${config.dnsDirective}\n\t}`;
}

function staticFilesRoute(
  root: string,
  fallback: string,
  matcher: string,
): string[] {
  return [
    '\t\troute {',
    `\t\t\troot * ${root}`,
    `\t\t\ttry_files {path} ${fallback}`,
    '\t\t\theader Cache-Control "no-cache"',
    `\t\t\t@${matcher} path_regexp ${matcher} -[A-Za-z0-9_-]{8}\\.[^/]+$`,
    `\t\t\theader @${matcher} Cache-Control "public, max-age=31536000, immutable"`,
    '\t\t\tfile_server',
    '\t\t}',
  ];
}

/** Route handlers shared by every site. `handle` blocks are source-ordered / first-match /
 * terminal, so the LAN guard precedes reverse_proxy/file_server with no Caddy
 * directive-reorder risk. `remote_ip` is the immediate connection peer: Docker userland
 * proxies or upstream SNAT can replace the original source with a private address;
 * private-source filtering cannot distinguish those requests from LAN clients. */
function handlers(config: EdgeConfig, upstream: string): string[] {
  const lines: string[] = ['\tencode zstd gzip'];
  if (config.webDomain && config.webDomain !== config.domain) {
    // Host is the logical authority even when SRV delegates the connection.
    // Apply the boundary before static routes, API proxying, or SPA fallback.
    lines.push(
      '\t@identity_application {',
      `\t\thost ${config.domain}`,
      '\t\tnot path /somfp/*',
      '\t}',
      '\t@application_federation {',
      `\t\tnot host ${config.domain}`,
      '\t\tpath /somfp/*',
      '\t}',
      '\thandle @identity_application {',
      '\t\trespond 404',
      '\t}',
      '\thandle @application_federation {',
      '\t\trespond 404',
      '\t}',
    );
  }
  // Fixed-name worker scripts must revalidate and must never fall back to SPA HTML.
  lines.push(
    '\thandle /push/*.js {',
    '\t\troot * /app/public/web',
    '\t\theader Cache-Control "no-cache"',
    '\t\tfile_server',
    '\t}',
  );
  // Discovery and versioned federation endpoints share one preserved prefix.
  lines.push(
    '\t# SOMFP discovery and versioned endpoints are served by Fastify.',
    '\thandle /somfp/* {',
    `\t\treverse_proxy ${upstream}`,
    '\t}',
  );
  if (config.adminAccess === 'lan') {
    lines.push(
      '\t@not_lan not remote_ip 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 127.0.0.1 ::1 fc00::/7 fe80::/10',
      // Admin API + admin page - LAN-only (403 otherwise); MUST precede the generic /api* handle.
      '\t# Admin API + admin page - LAN-only (403 otherwise); MUST precede the generic /api* handle.',
      '\thandle /api/v1/admin* {',
      '\t\trespond @not_lan 403',
      `\t\treverse_proxy ${upstream}`,
      '\t}',
      // React Router uses /admin/ as its basename; canonicalize the bare mount before serving the SPA.
      '\t# React Router uses /admin/ as its basename; canonicalize the bare mount before serving the SPA.',
      '\thandle /admin {',
      '\t\troute {',
      '\t\t\trespond @not_lan 403',
      '\t\t\tredir * /admin/ 308',
      '\t\t}',
      '\t}',
      '\thandle /admin* {',
      '\t\trespond @not_lan 403',
      ...staticFilesRoute(
        '/app/public',
        '/admin/index.html',
        'admin_immutable',
      ),
      '\t}',
      '\t# Fastify origin on loopback: consumer API (incl. SSE) + auth-gated /uploads.',
      '\thandle /api* {',
      `\t\treverse_proxy ${upstream}`,
      '\t}',
      '\thandle /uploads* {',
      `\t\treverse_proxy ${upstream}`,
      '\t}',
    );
  } else {
    lines.push(
      '\t# Fastify origin on loopback: API (incl. SSE) + auth-gated /uploads (Caddy cannot do the cookie auth).',
      '\thandle /api* {',
      `\t\treverse_proxy ${upstream}`,
      '\t}',
      '\thandle /uploads* {',
      `\t\treverse_proxy ${upstream}`,
      '\t}',
      '\t# Frontend dist (baked into the image) — Caddy serves it; Fastify is API-only.',
      '\tredir /admin /admin/ 308',
      '\thandle /admin* {',
      ...staticFilesRoute(
        '/app/public',
        '/admin/index.html',
        'admin_immutable',
      ),
      '\t}',
    );
  }
  lines.push(
    '\thandle {',
    ...staticFilesRoute('/app/public/web', '/index.html', 'web_immutable'),
    '\t}',
  );
  // A route preserves the host-denial handlers ahead of path-specific handles;
  // Caddy's normal directive sorting otherwise prioritizes path matchers.
  return config.webDomain && config.webDomain !== config.domain
    ? ['\troute {', ...lines.map((line) => `\t${line}`), '\t}']
    : lines;
}

/**
 * Render the complete Caddyfile.
 *
 *   single-port  HTTPS on the compose port (7667), DNS-01 wildcard cert, no HTTP redirect.
 *                + SOMS_LAN_DOMAIN set → ALSO an https://<lan-domain>:7667 site (own DNS-01
 *                cert, same zone).
 *   standard     HTTPS on 443 + auto 80→443 redirect, AND 7667 for federation (one shared
 *                cert via the (soms_site) snippet) unless the origin listens on a backend
 *                socket. + SOMS_LAN_DOMAIN set → additional https://<lan-domain> sites
 *                (own DNS-01 cert).
 *   disabled     plain HTTP on 7667, no cert (+ http://<lan-domain>:7667 if set).
 *
 * SOMS_ADMIN_ACCESS=lan layers a @not_lan guard onto the admin area (page + API) in every
 * mode. SOMS_EDGE_PORT rewrites the published edge port in single-port/disabled mode;
 * standard mode always serves 443 (+ 7667 for federation without a backend socket).
 */
export function renderCaddyfile(config: EdgeConfig): string {
  const upstream = config.backendSocket
    ? `unix/${config.backendSocket}`
    : '127.0.0.1:3000';
  const tls = tlsBlock(config);
  const scheme = config.tlsMode === 'disabled' ? 'http' : 'https';
  // Standard mode serves federation on canonical 7667 in addition to 443, but host-network
  // deployments with a backend socket keep the edge minimal (443 only).
  const federationSites =
    config.tlsMode === 'standard' && !config.backendSocket;

  const blocks: string[] = [];
  blocks.push(
    config.tlsMode === 'standard'
      ? // No disable_redirects → auto 80→443 redirect.
        [
          '{',
          '\tstorage file_system {',
          '\t\troot /app/data/caddy',
          '\t}',
          '}',
        ].join('\n')
      : [
          '{',
          '\tauto_https disable_redirects',
          '\tstorage file_system {',
          '\t\troot /app/data/caddy',
          '\t}',
          '}',
        ].join('\n'),
  );

  if (config.tlsMode === 'standard') {
    // Shared snippet: one cert + handler set reused by every site address.
    blocks.push(
      ['(soms_site) {', tls, ...handlers(config, upstream), '}'].join('\n'),
    );
    const importSite = (...addresses: string[]) =>
      [`${addresses.join(', ')} {`, '\timport soms_site', '}'].join('\n');
    if (config.certMode === 'alpn') {
      // TLS-ALPN-01 cannot certify wildcards, so each hostname gets its own exact site.
      blocks.push(importSite(`https://${config.domain}`));
      if (federationSites)
        blocks.push(importSite(`https://${config.domain}:7667`));
      if (config.webDomain && config.webDomain !== config.domain) {
        blocks.push(importSite(`https://${config.webDomain}`));
        if (federationSites)
          blocks.push(importSite(`https://${config.webDomain}:7667`));
      }
    } else {
      blocks.push(
        importSite(`https://${config.domain}`, `https://*.${config.domain}`),
      );
      if (federationSites)
        blocks.push(
          importSite(
            `https://${config.domain}:7667`,
            `https://*.${config.domain}:7667`,
          ),
        );
      if (
        config.webDomain &&
        !coveredByIdentitySite(config.webDomain, config.domain)
      ) {
        blocks.push(importSite(`https://${config.webDomain}`));
        if (federationSites)
          blocks.push(importSite(`https://${config.webDomain}:7667`));
      }
      // LAN domain (own DNS-01 cert via the same provider/zone) — only when configured.
      if (
        config.lanDomain &&
        !coveredByIdentitySite(config.lanDomain, config.domain)
      ) {
        blocks.push(
          importSite(
            `https://${config.lanDomain}`,
            `https://*.${config.lanDomain}`,
          ),
        );
        if (federationSites)
          blocks.push(
            importSite(
              `https://${config.lanDomain}:7667`,
              `https://*.${config.lanDomain}:7667`,
            ),
          );
      }
    }
  } else {
    // Single-port/disabled: every site carries the TLS block and handlers inline.
    const port = config.edgePort !== 7667 ? config.edgePort : 7667;
    const inlineSite = (...addresses: string[]) =>
      [
        `${addresses.join(', ')} {`,
        ...(tls ? [tls] : []),
        ...handlers(config, upstream),
        '}',
      ].join('\n');
    blocks.push(
      inlineSite(
        `${scheme}://${config.domain}:${port}`,
        `${scheme}://*.${config.domain}:${port}`,
      ),
    );
    if (
      config.webDomain &&
      !coveredByIdentitySite(config.webDomain, config.domain)
    ) {
      blocks.push(inlineSite(`${scheme}://${config.webDomain}:${port}`));
    }
    // LAN domain (own DNS-01 cert via the same provider/zone) — only when configured.
    // `disabled` mode serves it over plain HTTP (tls empty); single-port mints a cert via
    // the same TLS block.
    if (
      config.lanDomain &&
      !coveredByIdentitySite(config.lanDomain, config.domain)
    ) {
      blocks.push(
        inlineSite(
          `${scheme}://${config.lanDomain}:${port}`,
          `${scheme}://*.${config.lanDomain}:${port}`,
        ),
      );
    }
  }

  let out = blocks.join('\n') + '\n';
  if (config.backendSocket) {
    // Host networking must not bind Caddy's administrative API to a host TCP port.
    out = out.replace(
      /^\tstorage file_system {$/m,
      '\tadmin off\n\tstorage file_system {',
    );
  }
  return out;
}
