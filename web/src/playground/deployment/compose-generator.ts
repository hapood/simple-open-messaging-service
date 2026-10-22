export interface DeploymentConfig {
  /** Public mode fixes web ports at 80/443 and federation at 7667. */
  mode: 'public' | 'nas';
  /** Federation port, or the single published port in the single-port family. */
  port: number;
  domain: string;
  webDomain: string;
  lanDomain: string;
  database: string;
  databaseUser: string;
  databasePassword: string;
  adminPassword: string;
  dnsProvider: 'cloudflare' | 'alidns' | 'tencentcloud';
  dnsToken: string;
  aliyunKeyId: string;
  aliyunKeySecret: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  image: string;
  adminAccess: 'lan' | 'public';
}

export const initialDeployment: DeploymentConfig = {
  mode: 'nas',
  port: 7667,
  domain: '',
  webDomain: '',
  lanDomain: '',
  database: 'soms',
  databaseUser: 'timescale',
  databasePassword: randomPassword(),
  adminPassword: '',
  dnsProvider: 'cloudflare',
  dnsToken: '',
  aliyunKeyId: '',
  aliyunKeySecret: '',
  tencentSecretId: '',
  tencentSecretKey: '',
  image: 'ghcr.io/hapood/simple-open-messaging-service:v0.1.0-alpha.0',
  adminAccess: 'lan',
};

/** Per-shape defaults applied when the deployment shape changes. */
export function defaultsForMode(
  mode: DeploymentConfig['mode'],
): Pick<DeploymentConfig, 'port' | 'adminAccess'> {
  if (mode === 'public') {
    return { port: 7667, adminAccess: 'public' };
  }
  return { port: 7667, adminAccess: 'lan' };
}

export function publishedPort(c: DeploymentConfig): number {
  return c.mode === 'public' ? 443 : c.port;
}

/** YAML scalar escaping and Compose interpolation escaping are independent. */
export function composeScalar(value: string): string {
  return JSON.stringify(value.replaceAll('$', () => '$$'));
}

export const dnsProviders = {
  cloudflare: {
    fields: ['dnsToken'],
    env: ['CLOUDFLARE_API_TOKEN'],
    directive: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
  },
  alidns: {
    fields: ['aliyunKeyId', 'aliyunKeySecret'],
    env: ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET'],
    directive:
      'dns alidns {\n  access_key_id {env.ALIYUN_ACCESS_KEY_ID}\n  access_key_secret {env.ALIYUN_ACCESS_KEY_SECRET}\n}',
  },
  tencentcloud: {
    fields: ['tencentSecretId', 'tencentSecretKey'],
    env: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
    directive:
      'dns tencentcloud {\n  secret_id {env.TENCENTCLOUD_SECRET_ID}\n  secret_key {env.TENCENTCLOUD_SECRET_KEY}\n}',
  },
} as const;
export type DnsField =
  (typeof dnsProviders)[keyof typeof dnsProviders]['fields'][number];

/** Blocking issues (field keys). Empty list means the configuration is exportable. */
export function deploymentIssues(c: DeploymentConfig): string[] {
  const issues: string[] = [];
  const hostname =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const [name, value] of [
    ['domain', c.domain],
    ['webDomain', c.webDomain],
    ['lanDomain', c.lanDomain],
  ])
    if ((name !== 'lanDomain' || value) && !hostname.test(value))
      issues.push(name);
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    issues.push('port');
  if (c.mode === 'public' && c.port !== 7667) issues.push('publicPort');
  if (!c.database || !c.databaseUser) issues.push('database');
  if (c.databasePassword.length < 16) issues.push('databasePassword');
  if (c.adminPassword.length < 16) issues.push('adminPassword');
  const provider = dnsProviders[c.dnsProvider];
  if (!provider) issues.push('dnsProvider');
  else for (const key of provider.fields) if (!c[key].trim()) issues.push(key);

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(c.image)) issues.push('image');
  return issues;
}

/** Transform the canonical NAS template, refusing changed structure instead of silently
 * generating a stale service definition. Keep operational values in a top-level block. */
export function generateCompose(template: string, c: DeploymentConfig): string {
  const scalar = composeScalar;
  const origins = [c.webDomain, c.lanDomain]
    .filter(Boolean)
    .map((d) =>
      c.mode === 'public' ? `https://${d}` : `https://${d}:${c.port}`,
    )
    .join(',');
  const anchors: [string, string, string][] = [
    ['image', 'app-image', scalar(c.image)],
    ['identity_domain', 'identity-domain', scalar(c.domain)],
    ['web_domain', 'web-domain', scalar(c.webDomain)],
    ['lan_domain', 'lan-domain', scalar(c.lanDomain)],
    ['published_port', 'published-port', scalar(String(publishedPort(c)))],
    ['database_name', 'database-name', scalar(c.database)],
    ['database_user', 'database-user', scalar(c.databaseUser)],
    ['database_password', 'database-password', scalar(c.databasePassword)],
    ['admin_password', 'admin-password', scalar(c.adminPassword)],
    ...dnsProviders[c.dnsProvider].fields.map(
      (field): [string, string, string] => [field, field, scalar(c[field])],
    ),
    ['admin_access', 'admin-access', scalar(c.adminAccess)],
    ['webauthn_origins', 'webauthn-origins', scalar(origins)],
  ];
  const start = template.indexOf('x-database-environment:');
  if (start < 0)
    throw new Error('Unsupported NAS template: database anchor missing.');
  // The generator supplies its own contextual comments; canonical service definitions remain.
  let body = template
    .slice(start)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const replace = (pattern: RegExp, value: string, count = 1) => {
    const matches = body.match(new RegExp(pattern.source, 'gm')) ?? [];
    if (matches.length !== count)
      throw new Error(`NAS template changed: ${pattern.source}`);
    body = body.replace(new RegExp(pattern.source, 'gm'), value);
  };
  const provider = dnsProviders[c.dnsProvider];
  replace(
    /^      CADDY_DNS_DIRECTIVE:.*$/,
    `      CADDY_DNS_DIRECTIVE: ${scalar(provider.directive)}`,
  );
  replace(
    /^      CLOUDFLARE_API_TOKEN:.*$/,
    provider.fields
      .map((field, i) => `      ${provider.env[i]}: *${field}`)
      .join('\n'),
  );
  replace(/^  PGDATABASE:.*$/, '  PGDATABASE: *database-name');
  replace(/^  PGUSER:.*$/, '  PGUSER: *database-user');
  replace(/^  PGPASSWORD:.*$/, '  PGPASSWORD: *database-password');
  replace(
    /^    image: ghcr\.io\/hapood\/simple-open-messaging-service:.*$/,
    '    image: *app-image',
    2,
  );
  for (const [key, anchor] of [
    ['SOMS_DOMAIN', 'identity-domain'],
    ['SOMS_WEB_DOMAIN', 'web-domain'],
    ['SOMS_LAN_DOMAIN', 'lan-domain'],
    ['ADMIN_BOOTSTRAP_PASSWORD', 'admin-password'],
    ['SOMS_ADMIN_ACCESS', 'admin-access'],
  ])
    replace(new RegExp(`^      ${key}:.*$`), `      ${key}: *${anchor}`);
  replace(
    /^      SOMS_TLS_MODE: single-port$/,
    `      SOMS_TLS_MODE: ${c.mode === 'public' ? 'standard' : 'single-port'}\n      SOMS_WEBAUTHN_ALLOWED_ORIGINS: *webauthn-origins`,
  );
  if (c.mode === 'public') {
    // In public mode, all traffic (web, api, federation) goes through standard 80/443 ports
    const portsBlock =
      '    ports:\n' +
      "      - { target: 80, published: '80', protocol: tcp }\n" +
      "      - { target: 443, published: '443', protocol: tcp }\n" +
      "      - { target: 443, published: '443', protocol: udp }";
    replace(/^    ports:\n(?: {6,}[^\n]*\n?)+/m, portsBlock + '\n');
  } else {
    replace(
      /^        published: '7667'$/,
      '        published: *published-port',
      2,
    );
  }
  const header =
    `# SOMS deployment — generated locally in your browser.\n` +
    '# Contains secrets. Keep private; do not commit to version control.\n' +
    '# Edit only this block for routine configuration changes. $$ represents a literal $.\n' +
    '# Changing password values does NOT rotate existing database or admin credentials.\n';
  return (
    header +
    'x-settings:\n' +
    anchors
      .map(([key, anchor, value]) => `  ${key}: &${anchor} ${value}`)
      .join('\n') +
    '\n\n' +
    body.replace(/\n{3,}/g, '\n\n')
  );
}

export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
