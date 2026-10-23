import { DEFAULT_EDGE_PORT } from '../../../../shared/deployment-ports';

export interface DeploymentConfig {
  /** Public mode fixes web ports at 80/443 and federation at 7667. */
  mode: 'public' | 'nas';
  /** Federation port, or the single published port in the single-port family. */
  port: number;
  domain: string;
  webDomain: string;
  lanDomain: string;
  dataDir: string;
  database: string;
  databaseUser: string;
  databasePassword: string;
  databaseMode: 'builtin' | 'remote';
  remoteHost: string;
  remotePort: number;
  remoteTls: boolean;
  remoteCaPath: string;
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
  port: DEFAULT_EDGE_PORT,
  domain: '',
  webDomain: '',
  lanDomain: '',
  dataDir: '',
  database: 'soms',
  databaseUser: 'timescale',
  databasePassword: randomPassword(),
  databaseMode: 'builtin',
  remoteHost: '',
  remotePort: 5432,
  remoteTls: true,
  remoteCaPath: '',
  adminPassword: '',
  dnsProvider: 'cloudflare',
  dnsToken: '',
  aliyunKeyId: '',
  aliyunKeySecret: '',
  tencentSecretId: '',
  tencentSecretKey: '',
  image: 'ghcr.io/hapood/simple-open-messaging-service:latest',
  adminAccess: 'lan',
};

/** Per-shape defaults applied when the deployment shape changes. */
export function defaultsForMode(
  mode: DeploymentConfig['mode'],
): Pick<DeploymentConfig, 'port' | 'adminAccess'> {
  return {
    port: DEFAULT_EDGE_PORT,
    adminAccess: mode === 'public' ? 'public' : 'lan',
  };
}

/** In-memory tab state only; never persist deployment secrets in browser storage. */
export class DeploymentModeState {
  private readonly settings = {
    public: defaultsForMode('public'),
    nas: defaultsForMode('nas'),
  };

  switch(
    current: DeploymentConfig,
    mode: DeploymentConfig['mode'],
  ): DeploymentConfig {
    this.settings[current.mode] = {
      port: current.port,
      adminAccess: current.adminAccess,
    };
    return { ...current, mode, ...this.settings[mode] };
  }
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
  if (!hostname.test(c.domain.trim())) {
    issues.push('domain');
  }
  if (c.webDomain.trim() && !hostname.test(c.webDomain.trim())) {
    issues.push('webDomain');
  }
  if (c.lanDomain.trim() && !hostname.test(c.lanDomain.trim())) {
    issues.push('lanDomain');
  }
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    issues.push('port');
  if (c.mode === 'public' && c.port !== DEFAULT_EDGE_PORT)
    issues.push('publicPort');
  if (!c.dataDir.trim()) issues.push('dataDir');
  if (!c.database || !c.databaseUser) issues.push('database');
  if (c.databasePassword.length < 16) issues.push('databasePassword');
  if (c.databaseMode === 'remote') {
    if (
      !/^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|\[[a-fA-F0-9:]+\])$/.test(
        c.remoteHost.trim(),
      )
    )
      issues.push('remoteHost');
    if (
      !Number.isInteger(c.remotePort) ||
      c.remotePort < 1 ||
      c.remotePort > 65535
    )
      issues.push('remotePort');
    if (
      c.remoteCaPath &&
      (!c.remoteCaPath.startsWith('/') || /[\s\x00]/.test(c.remoteCaPath))
    )
      issues.push('remoteCaPath');
  }
  if (!c.adminPassword.trim()) issues.push('adminPassword');
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
  const webDomain = c.webDomain.trim() || c.domain.trim();
  const origins = [webDomain, c.lanDomain.trim()]
    .filter(Boolean)
    .map((d) =>
      c.mode === 'public' ? `https://${d}` : `https://${d}:${c.port}`,
    )
    .join(',');
  const anchors: [string, string, string][] = [
    ['image', 'app-image', scalar(c.image)],
    ['identity_domain', 'identity-domain', scalar(c.domain.trim())],
    ['web_domain', 'web-domain', scalar(webDomain)],
    ['lan_domain', 'lan-domain', scalar(c.lanDomain.trim())],
    ['published_port', 'published-port', scalar(String(publishedPort(c)))],
    ['data_dir', 'data-dir', scalar(c.dataDir.trim())],
    ['database_name', 'database-name', scalar(c.database)],
    ['database_user', 'database-user', scalar(c.databaseUser)],
    ['database_password', 'database-password', scalar(c.databasePassword)],
    ...(c.databaseMode === 'remote'
      ? ([
          ['database_host', 'database-host', scalar(c.remoteHost.trim())],
          ['database_port', 'database-port', scalar(String(c.remotePort))],
        ] as [string, string, string][])
      : []),
    ['admin_password', 'admin-password', scalar(c.adminPassword.trim())],
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
  replace(
    /^ {6}- \.\/data:\/app\/data$/m,
    '      - type: bind\n        source: *data-dir\n        target: /app/data',
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
  // Host networking removes Docker's published-port proxy. The origin and Caddy talk over
  // a private Unix socket; the built-in database shares a separate PostgreSQL socket volume.
  replace(/^    ports:\n(?: {6,}[^\n]*\n?)+/m, '    network_mode: host\n');
  replace(
    /^      TRUSTED_PROXY_CIDRS:.*$/,
    `      TRUSTED_PROXY_CIDRS: '127.0.0.0/8,::1/128'\n      SOMS_BACKEND_SOCKET: /tmp/soms/backend.sock\n      SOMS_EDGE_PORT: ${c.mode === 'public' ? DEFAULT_EDGE_PORT : '*published-port'}`,
  );
  if (c.databaseMode === 'builtin') {
    replace(/^  PGHOST: postgres$/, '  PGHOST: /var/run/postgresql');
    replace(
      /^    image: postgres:18$/,
      `    image: postgres:18
    entrypoint:
      - /bin/sh
      - -ec
      - |
        printf 'local all all scram-sha-256\\nhost all all 0.0.0.0/0 scram-sha-256\\nhost all all ::/0 scram-sha-256\\n' > /tmp/soms_pg_hba.conf
        exec docker-entrypoint.sh postgres -c hba_file=/tmp/soms_pg_hba.conf`,
    );
    replace(
      /^      - postgres-data:.*$/,
      '      - postgres-data:/var/lib/postgresql\n      - postgres-socket:/var/run/postgresql',
    );
    replace(
      /^    command: \['node', 'dist\/scripts\/migrate-db.js', 'migrate'\]$/,
      "    command: ['node', 'dist/scripts/migrate-db.js', 'migrate']\n    volumes:\n      - postgres-socket:/var/run/postgresql",
    );
    replace(
      /^        target: \/app\/data$/,
      '        target: /app/data\n      - postgres-socket:/var/run/postgresql',
    );
  } else {
    replace(/^  PGHOST: postgres$/, '  PGHOST: *database-host');
    replace(/^  PGPORT: '5432'$/, '  PGPORT: *database-port');
    // Remove only the postgres service, and its dependencies. Both jobs use the remote host.
    replace(/^  postgres:\n[\s\S]*?(?=  migrate:\n)/m, '');
    replace(
      /^    depends_on:\n      postgres:\n        condition: service_healthy\n    command:/,
      '    command:',
    );
    replace(
      /^      postgres:\n        condition: service_healthy\n      migrate:/,
      '      migrate:',
    );
    replace(
      /^    command: \['node', 'dist\/scripts\/migrate-db.js', 'migrate'\]$/,
      "    command: ['node', 'dist/scripts/migrate-db.js', 'migrate']\n    network_mode: host",
    );
    if (c.remoteTls) {
      replace(
        /^  PGPASSWORD: \*database-password$/,
        '  PGPASSWORD: *database-password\n  SOMS_DB_TLS: verify-full',
      );
    }
    if (c.remoteCaPath.trim()) {
      replace(
        /^  PGPASSWORD: \*database-password$/,
        '  PGPASSWORD: *database-password\n  SOMS_DB_CA_FILE: /tmp/soms/db-ca.pem',
      );
      replace(
        /^    command: \['node', 'dist\/scripts\/migrate-db.js', 'migrate'\]\n    network_mode: host$/,
        `    command: ['node', 'dist/scripts/migrate-db.js', 'migrate']\n    network_mode: host\n    volumes:\n      - type: bind\n        source: ${scalar(c.remoteCaPath.trim())}\n        target: /tmp/soms/db-ca.pem\n        read_only: true`,
      );
      replace(
        /^        target: \/app\/data$/,
        `        target: /app/data\n      - type: bind\n        source: ${scalar(c.remoteCaPath.trim())}\n        target: /tmp/soms/db-ca.pem\n        read_only: true`,
      );
    }
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
    body
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()
      .replace(
        /\nvolumes:\n  postgres-data:\s*$/,
        c.databaseMode === 'builtin'
          ? '\nvolumes:\n  postgres-data:\n  postgres-socket:'
          : '',
      ) +
    '\n'
  );
}

export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
