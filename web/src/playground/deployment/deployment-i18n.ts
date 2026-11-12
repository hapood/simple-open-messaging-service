import type { TranslocoService } from '@jsverse/transloco';

export const deploymentMessages = {
  en: {
    nav: {
      chat: 'Chat demo',
      deploy: 'Deployment',
      effects: 'Effects & Motion',
      expand: 'Expand navigation',
      collapse: 'Collapse navigation',
      language: 'Language',
      theme: 'Theme',
    },
    themeSystem: 'Theme: System',
    themeLight: 'Theme: Light',
    themeDark: 'Theme: Dark',

    // Section 1: Environment
    environment: 'Deployment Environment & Network',
    environmentCaption:
      'Choose how users reach your server and obtain TLS certificates.',
    public: 'Standard Port (443)',
    nas: 'Custom Port',
    publicPorts: 'HTTPS 443 (HTTP 80 redirects to HTTPS)',
    port: 'Published Port',
    portHint:
      'Default 7667. Router port forwarding and DNS SRV records must match this port.',
    certMode: 'Certificate Challenge',
    certModeAlpn: 'Direct Port 443 (TLS-ALPN-01)',
    certModeDns: 'DNS-01 (API Key)',
    certModeAlpnHint:
      'Direct TLS handshake verification on port 443. Requires public port 443 reachability; no DNS provider tokens needed. Wildcard and LAN domains are not supported.',
    certModeDnsHint:
      'Verifies domain ownership via DNS TXT records. Supports wildcard subdomains and private LAN domains.',
    certModeLockedDns:
      'Custom ports cannot use port 443 ALPN challenge; DNS-01 verification is required.',
    acmeEmail: 'ACME Contact Email',
    acmeEmailPlaceholder: 'admin@example.com (optional)',
    acmeEmailHint:
      "Optional contact email for Let's Encrypt / ZeroSSL expiry notifications.",
    networkOptions: 'Network options',
    adminOnly: 'Restrict admin access to private network IPs',
    adminHint:
      'Restricts admin pages and APIs to private network IPs. Password login is always required.',

    // Section 2: Basics
    basic: 'Basic Configuration',
    basicCaption: 'Domain and administrator setup.',
    domains: 'Addresses',
    credentials: 'Credentials',
    domain: 'Identity Domain',
    domainHint:
      'The identity domain used in user handles (e.g. user@example.com).',
    dataDir: 'Data Directory',
    dataDirHint:
      'Host directory for server state and certificates (e.g. ./data or an absolute path). Create it before launching and ensure the container can write to it.',
    customDomains: 'Independent Server / LAN Hostnames (Optional)',
    webDomain: 'Server Hostname',
    webDomainPlaceholder: 'Defaults to identity domain (e.g. soms.example.com)',
    webDomainHint:
      'Web and client connection address. Defaults to identity domain if omitted.',
    lanDomain: 'LAN Hostname',
    lanDomainHint:
      'Direct LAN address resolved to a private IP (for networks without NAT loopback).',
    lanDomainDisabledHint:
      'LAN domains resolve to private IPs unreachable by external ACME servers. Use DNS-01 challenge mode to certify LAN domains.',
    optional: 'optional',
    databasePassword: 'Database Password',
    databasePasswordHint: 'Password for PostgreSQL database connection.',
    adminPassword: 'Initial Admin Password',
    adminPasswordHint:
      'Initial password for the admin account. Updating compose later will not reset existing credentials.',
    random: 'Generate',
    passwordPlaceholder: 'Enter password',

    // DNS & Certificates
    dnsAndCert: 'DNS Provider & Credentials',
    dnsProvider: 'DNS Provider',
    dnsProviderHint: 'Select your domain DNS provider.',
    providerCloudflare: 'Cloudflare',
    providerAlidns: 'Alibaba Cloud DNS (AliDNS)',
    providerTencentcloud: 'Tencent Cloud DNS',
    dnsToken: 'Cloudflare API Token',
    dnsTokenHint:
      'Requires Zone:Read and DNS:Edit permissions for the target zone.',
    aliyunKeyId: 'AccessKey ID',
    aliyunKeyIdHint:
      'Alibaba Cloud RAM user AccessKey ID with DNS permissions.',
    aliyunKeySecret: 'AccessKey Secret',
    aliyunKeySecretHint: 'Alibaba Cloud RAM user AccessKey Secret.',
    tencentSecretId: 'SecretId',
    tencentSecretIdHint: 'Tencent Cloud CAM SecretId with DNS permissions.',
    tencentSecretKey: 'SecretKey',
    tencentSecretKeyHint: 'Tencent Cloud CAM SecretKey.',

    // Section 3: Advanced
    advanced: 'Advanced Configuration',
    databaseMode: 'PostgreSQL connection',
    databaseBuiltin: 'Bundled database (Unix socket)',
    databaseRemote: 'Remote database (TCP)',
    remoteHost: 'Database host',
    remotePort: 'Database port',
    remoteTls: 'Verify remote TLS certificate',
    remoteCaPath: 'Host path to private CA certificate (optional)',
    database: 'Database Name',
    databaseUser: 'Database User',
    databaseHint:
      'Internal database identifiers. Do not change casually once initialized.',
    image: 'Image Version',
    imageHint:
      'Container image for application and migration services. Defaults to official release.',

    // Output & Checklist
    checklist: 'Deployment Steps',
    copy: 'Copy',
    download: 'Download',
    invalidTitle: 'Incomplete Configuration',
    invalidHint:
      'Fill in all required fields to preview and download docker-compose.yml.',
    live: 'Live Preview',
    loading: 'Loading deployment template…',
    templateError: 'Template unavailable. Please reload and try again.',
    copied: '✓ Copied',
    dnsStep: '1. DNS Configuration',
    dnsHint:
      'Point server hostname A/AAAA records to your server (DNS-only) and add this SRV record:',
    dnsHintWithLan:
      'Add A/AAAA records (DNS-only for server, private IP for LAN) and federation SRV record:',
    portsStep: '2. Network & Ports',
    portsHint:
      'Forward required ports in router or firewall (UDP enables HTTP/3):',
    startStep: '3. Start Stack',
    startHint:
      'Create the configured data directory, save docker-compose.yml in the deployment directory, then start the stack:',
    dataDirPermissionsComment:
      'Create the data directory; ensure the container can write to it before starting.',
    verifyStep: '4. Verification',
    verifyHint: 'Access the URL in a browser to verify the service status.',
    verifyPublic: 'Public: ',
    verifyLan: 'LAN: ',
  },
  zh: {
    nav: {
      chat: '聊天演示',
      deploy: '部署配置',
      effects: '交互动效展示',
      expand: '展开导航',
      collapse: '收起导航',
      language: '切换语言',
      theme: '切换主题',
    },
    themeSystem: '主题：跟随系统',
    themeLight: '主题：浅色模式',
    themeDark: '主题：深色模式',

    // Section 1: Environment
    environment: '部署环境与网络',
    environmentCaption: '选择服务器网络接入方式与 TLS 证书验证机制。',
    public: '标准端口 (443)',
    nas: '非标准端口',
    publicPorts: 'HTTPS 443（HTTP 80 自动重定向至 HTTPS）',
    port: '对外发布端口',
    portHint: '默认 7667。路由器端口转发与 DNS SRV 记录需与此一致。',
    certMode: '证书验证方式',
    certModeAlpn: '直接 443 端口验证 (TLS-ALPN-01)',
    certModeDns: 'DNS-01 验证 (API 密钥)',
    certModeAlpnHint:
      '直接通过公网 443 端口发起 TLS 握手验证，无需任何 DNS 服务商 API 密钥。要求公网 443 端口直通，不支持通配符或内网域名。',
    certModeDnsHint:
      '通过 DNS TXT 记录验证域名所有权，支持通配符子域名与私网内网域名。',
    certModeLockedDns:
      '非标准端口外部无法直接进行 443 握手挑战，必须使用 DNS-01 验证。',
    acmeEmail: '证书通知邮箱',
    acmeEmailPlaceholder: 'admin@example.com（选填）',
    acmeEmailHint: "选填，用于接收 Let's Encrypt / ZeroSSL 证书到期告警通知。",
    networkOptions: '网络选项',
    adminOnly: '仅允许私网 IP 访问管理后台',
    adminHint: '开启后仅允许私网 IP 访问管理后台页面及 API（均仍需密码登录）。',

    // Section 2: Basics
    basic: '基础配置',
    basicCaption: '设置域名与初始管理员密码。',
    domains: '域名设置',
    credentials: '管理员设置',
    domain: '身份域名',
    domainHint: '用于用户身份标识（如 user@example.com 中的 example.com）。',
    dataDir: '数据目录',
    dataDirHint:
      '存放服务端数据与证书的宿主机目录（如 ./data 或绝对路径）。启动前请创建目录，并确保容器有写入权限。',
    customDomains: '独立服务域名 / 内网域名（选填）',
    webDomain: '服务域名',
    webDomainPlaceholder: '默认同身份域名，如 soms.example.com',
    webDomainHint: 'Web 与客户端连接地址。留空则默认使用身份域名。',
    lanDomain: '内网域名',
    lanDomainHint:
      '局域网直连域名，解析至服务器私网 IP（用于不支持 NAT 回流的网络）。',
    lanDomainDisabledHint:
      '内网域名解析至私有 IP，公网 CA 无法通过 443 端口探测。配置内网域名时必须选用 DNS-01 验证模式。',
    optional: '选填',
    databasePassword: '数据库密码',
    databasePasswordHint: 'PostgreSQL 数据库连接密码。',
    adminPassword: '初始管理员密码',
    adminPasswordHint:
      '初次启动时创建 admin 账号的密码，后续修改配置不会覆盖已有密码。',
    random: '随机生成',
    passwordPlaceholder: '请输入密码',

    // DNS & Certificates
    dnsAndCert: 'DNS 服务商凭证',
    dnsProvider: 'DNS 服务商',
    dnsProviderHint: '选择域名的 DNS 托管服务商。',
    providerCloudflare: 'Cloudflare',
    providerAlidns: '阿里云 DNS (AliDNS)',
    providerTencentcloud: '腾讯云 DNS',
    dnsToken: 'Cloudflare API 令牌',
    dnsTokenHint: '需具备对应托管区域的 Zone:Read 与 DNS:Edit 权限。',
    aliyunKeyId: 'AccessKey ID',
    aliyunKeyIdHint: '具备 DNS 解析权限的阿里云 RAM 用户 AccessKey ID。',
    aliyunKeySecret: 'AccessKey Secret',
    aliyunKeySecretHint: '阿里云 RAM 用户 AccessKey Secret。',
    tencentSecretId: 'SecretId',
    tencentSecretIdHint: '具备 DNS 解析权限的腾讯云 CAM 访问密钥 SecretId。',
    tencentSecretKey: 'SecretKey',
    tencentSecretKeyHint: '腾讯云 CAM 访问密钥 SecretKey。',

    // Section 3: Advanced
    advanced: '高级配置',
    databaseMode: 'PostgreSQL 连接方式',
    databaseBuiltin: '自带数据库（Unix socket）',
    databaseRemote: '远端数据库（TCP）',
    remoteHost: '数据库主机名',
    remotePort: '数据库端口',
    remoteTls: '验证远端 TLS 证书',
    remoteCaPath: '宿主机 CA 证书绝对路径（可选）',
    database: '数据库名称',
    databaseUser: '数据库用户',
    databaseHint: '数据库内部标识，已有数据时请勿随意更改。',
    image: '镜像版本',
    imageHint: '应用容器镜像地址，默认使用官方发布版本。',

    // Output & Checklist
    checklist: '部署步骤',
    copy: '复制配置',
    download: '下载配置',
    invalidTitle: '配置未填完整',
    invalidHint: '请完善左侧必填项后查看实时配置预览并下载。',
    live: '实时配置预览',
    loading: '正在加载部署模板…',
    templateError: '模板加载失败，请刷新重试。',
    copied: '✓ 已复制',
    dnsStep: '1. DNS 记录配置',
    dnsHint: '添加服务域名 A/AAAA 解析（关闭代理）以及联邦 SRV 记录：',
    dnsHintWithLan:
      '添加域名 A/AAAA 解析（公网关闭代理，内网解析至私网 IP）以及联邦 SRV 记录：',
    portsStep: '2. 网络与端口映射',
    portsHint: '在路由器或防火墙中开放对应端口（UDP 用于 HTTP/3 提速）：',
    startStep: '3. 启动服务',
    startHint:
      '创建所填数据目录，将配置保存到部署目录中的 docker-compose.yml，然后启动：',
    dataDirPermissionsComment: '创建数据目录；启动前请确保容器对其有写入权限。',
    verifyStep: '4. 运行验证',
    verifyHint: '在浏览器或客户端中访问服务地址验证运行状态。',
    verifyPublic: '公网：',
    verifyLan: '内网：',
  },
};

export const issueMessages: Record<string, [string, string]> = {
  domain: ['请输入有效的身份域名。', 'Invalid identity domain.'],
  webDomain: [
    '服务域名须格式正确，并与身份域名属于同一可注册域名。',
    'Server hostname must be valid and share the identity hostname’s registrable domain.',
  ],
  lanDomain: [
    '内网域名须格式正确，并与身份域名属于同一可注册域名。',
    'LAN hostname must be valid and share the identity hostname’s registrable domain.',
  ],
  lanDomainRequiresDns: [
    '内网域名仅支持 DNS-01 验证，请切换为 DNS-01 模式或清空内网域名。',
    'LAN hostname requires DNS-01 challenge. Switch to DNS-01 mode or clear LAN hostname.',
  ],
  certMode: [
    '直接 443 端口验证仅在标准端口 (443) 下可用。',
    'Direct port 443 validation is only available on standard port (443).',
  ],
  acmeEmail: [
    '证书通知邮箱格式不正确。',
    'Invalid email address format for ACME contact.',
  ],
  dataDir: ['请填写数据目录。', 'Data directory is required.'],
  port: [
    '端口必须是 1–65535 的整数。',
    'Port must be an integer from 1 to 65535.',
  ],
  publicPort: [
    '公网模式联邦端口固定为 7667。',
    'Public federation port is fixed at 7667.',
  ],
  database: [
    '数据库名称和用户不能为空。',
    'Database name and user are required.',
  ],
  remoteHost: [
    '请输入远端数据库主机名。',
    'Enter a valid remote database hostname.',
  ],
  remotePort: [
    '数据库端口必须为 1–65535。',
    'Remote database port must be 1–65535.',
  ],
  remoteCaPath: [
    'CA 证书需填写宿主机绝对路径。',
    'CA certificate requires an absolute host path.',
  ],
  databasePassword: [
    '数据库密码至少需要 16 个字符。',
    'Database password needs at least 16 characters.',
  ],
  adminPassword: ['请填写管理员密码。', 'Admin password is required.'],
  dnsProvider: [
    '请选择有效的 DNS 服务商。',
    'Please select a valid DNS provider.',
  ],
  dnsToken: [
    '请填写 Cloudflare API 令牌。',
    'Please enter Cloudflare API token.',
  ],
  aliyunKeyId: [
    '请填写阿里云 AccessKey ID。',
    'Please enter Alibaba Cloud AccessKey ID.',
  ],
  aliyunKeySecret: [
    '请填写阿里云 AccessKey Secret。',
    'Please enter Alibaba Cloud AccessKey Secret.',
  ],
  tencentSecretId: [
    '请填写腾讯云 SecretId。',
    'Please enter Tencent Cloud SecretId.',
  ],
  tencentSecretKey: [
    '请填写腾讯云 SecretKey。',
    'Please enter Tencent Cloud SecretKey.',
  ],
  image: ['镜像地址格式不正确。', 'Invalid image reference.'],
};

export function ensureDeploymentTranslations(
  translator: TranslocoService,
): void {
  for (const [key, lang] of [
    ['en', 'en'],
    ['zh', 'zh-CN'],
  ] as const) {
    const errors = Object.fromEntries(
      Object.entries(issueMessages).map(([name, text]) => [
        name,
        text[key === 'zh' ? 0 : 1],
      ]),
    );
    translator.setTranslation(
      { deployment: { ...deploymentMessages[key], errors } },
      lang,
      { merge: true },
    );
  }
}
