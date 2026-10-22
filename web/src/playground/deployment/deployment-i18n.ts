export const deploymentMessages = {
  en: {
    nav: {
      chat: 'Chat demo',
      deploy: 'Deployment',
      expand: 'Expand navigation',
      collapse: 'Collapse navigation',
      language: 'Language',
      theme: 'Theme',
    },
    themeSystem: 'Theme: System',
    themeLight: 'Theme: Light',
    themeDark: 'Theme: Dark',

    // Section 1: Environment
    environment: 'Deployment Environment',
    environmentCaption: 'Choose how users reach your server.',
    public: 'Public Server',
    nas: 'LAN / NAS',
    publicPorts: 'HTTPS 443 (HTTP 80 redirects to HTTPS)',
    port: 'Published Port',
    portHint:
      'Default 7667. Change for additional instances on the same host; update port forwarding and DNS SRV accordingly.',
    adminOnly: 'Restrict admin access to private source IPs',
    adminHint:
      'Applies to admin pages and APIs. Login is always required. Source NAT can make public requests look private: this is not a VPN guarantee.',

    // Section 2: Basics
    basic: 'Basic Configuration',
    basicCaption: 'Domains and database credentials for your instance.',
    domains: 'Addresses',
    credentials: 'Credentials',
    domain: 'Identity Domain',
    domainHint:
      'The stable domain identifying your server to federation peers. Does not require an apex A record. All configured hostnames must share a registrable DNS zone.',
    webDomain: 'Server Hostname',
    webDomainHint:
      'The web entry and federation SRV target, e.g. soms.example.com. DNS A/AAAA record must point to a reachable server.',
    lanDomain: 'LAN Hostname',
    lanDomainHint:
      'Optional direct LAN or VPN entry, e.g. soms-lan.example.com, resolved to a private IP.',
    optional: 'optional',
    databasePassword: 'Database Password',
    databasePasswordHint:
      'The app uses this to connect to PostgreSQL, not to sign into the web UI. At least 16 characters.',
    adminPassword: 'Initial Admin Password',
    adminPasswordHint:
      'Creates the first admin account only. At least 16 characters. Editing this later does not reset existing accounts.',
    random: 'Generate',
    passwordHint: 'At least 16 characters',

    // Section 3: DNS & Certificates
    dnsAndCert: 'DNS & Certificates',
    dnsAndCertCaption: 'Automatic wildcard certificates via DNS-01 challenge.',
    dnsProvider: 'DNS Provider',
    dnsProviderHint:
      'Select the managed DNS provider for your domain. Wildcard TLS requires DNS-01 validation credentials.',
    providerCloudflare: 'Cloudflare',
    providerAlidns: 'Alibaba Cloud DNS (AliDNS)',
    providerTencentcloud: 'Tencent Cloud DNS',
    dnsToken: 'Cloudflare API Token',
    dnsTokenHint:
      'Scoped token with Zone Read and DNS Edit permissions for the managed zone. Not your account password.',
    aliyunKeyId: 'AccessKey ID',
    aliyunKeyIdHint: 'RAM user AccessKey ID with AlidnsFullAccess permission.',
    aliyunKeySecret: 'AccessKey Secret',
    aliyunKeySecretHint: 'RAM user AccessKey Secret.',
    tencentSecretId: 'SecretId',
    tencentSecretIdHint:
      'CAM API SecretId with DNSPod / DNS management permission.',
    tencentSecretKey: 'SecretKey',
    tencentSecretKeyHint: 'CAM API SecretKey.',

    // Section 4: Advanced
    advanced: 'Advanced Configuration',
    database: 'Database Name',
    databaseUser: 'Database User',
    databaseHint:
      'Shared by PostgreSQL, migrations and the app. Do not change casually on an existing database.',
    image: 'Image Version',
    imageHint:
      'Defaults to the v0.1.0-alpha.0 release image for amd64 and arm64. The app and migration service must use the same image. You can also enter a locally built image.',

    // Output & Checklist
    checklist: 'Deployment Steps',
    copy: 'Copy',
    download: 'Download',
    invalidTitle: 'Incomplete Configuration',
    invalidHint:
      'Fill in all required fields to preview and download docker-compose.yaml.',
    live: 'Live Preview',
    loading: 'Loading deployment template…',
    privacy:
      'Generated locally in your browser. Credentials are never uploaded or stored.',
    exportWarning:
      'Exported file contains plaintext credentials. Keep it secure.',
    templateError:
      'Template unavailable or incompatible. Please reload and try again.',
    copied:
      'Copied compose.yaml (including credentials). Clear your clipboard after use.',
    clipboardError: 'Clipboard unavailable. Please download the file instead.',
    downloaded: 'Downloaded compose.yaml.',
    dnsStep: '1. DNS Configuration',
    dnsHint:
      'Point the server hostname A/AAAA record to your server (DNS-only), then publish this SRV record:',
    portsStep: '2. Network & Ports',
    portsHint:
      'Forward TCP ports. UDP enables HTTP/3. Check return routing and admin isolation.',
    startStep: '3. Start Stack',
    startHint:
      'Save as compose.yaml in a dedicated private directory, then launch:',
    verifyStep: '4. Verification',
    verifyHint:
      'Access from an external network and test federation bidirectionally.',
  },
  zh: {
    nav: {
      chat: '聊天演示',
      deploy: '部署配置',
      expand: '展开导航',
      collapse: '收起导航',
      language: '切换语言',
      theme: '切换主题',
    },
    themeSystem: '主题：跟随系统',
    themeLight: '主题：浅色模式',
    themeDark: '主题：深色模式',

    // Section 1: Environment
    environment: '部署环境',
    environmentCaption: '选择用户和联邦节点访问服务器的网络形态。',
    public: '公网服务器',
    nas: '内网 / NAS',
    publicPorts: 'HTTPS 443（HTTP 80 自动重定向至 HTTPS）',
    port: '对外发布端口',
    portHint:
      '默认 7667。同一主机部署多个实例时可修改；路由器端口转发和 DNS SRV 记录须与此一致。',
    adminOnly: '仅允许私网来源 IP 访问管理后台',
    adminHint:
      '同时限制后台网页与管理 API，所有访问仍需密码登录。如果经过路由器源地址伪装 (SNAT)，公网请求可能伪装成私网来源，此开关不能代替完整 VPN 隔离。',

    // Section 2: Basics
    basic: '基础配置',
    basicCaption: '设置实例的主机域名与数据库凭据。',
    domains: '访问地址',
    credentials: '数据库凭据',
    domain: '身份域名',
    domainHint:
      '服务器在联邦中的稳定身份标识，无需将根域名 A 记录解析到本服务器。所有配置域名须属于同一注册主域，建立联邦关系后请勿修改。',
    webDomain: '服务域名',
    webDomainHint:
      '网页前端、客户端连接以及联邦 SRV 指向的外部地址，例如 soms.example.com。其 DNS A/AAAA 记录需直接解析到本服务器。',
    lanDomain: '内网域名',
    lanDomainHint:
      '选填，用于局域网或内网 VPN 直连，例如 soms-lan.example.com，解析至私网 IP。',
    optional: '选填',
    databasePassword: '数据库密码',
    databasePasswordHint:
      '后端应用连接 PostgreSQL 的数据库用户密码，不是网页登录密码。至少 16 个字符。',
    adminPassword: '初始管理员密码',
    adminPasswordHint:
      '仅在首次启动创建管理员账号时生效。至少 16 个字符。后续修改配置文件不会重置已有管理员密码。',
    random: '随机生成',
    passwordHint: '至少 16 个字符',

    // Section 3: DNS & Certificates
    dnsAndCert: 'DNS 与证书',
    dnsAndCertCaption: '通过 DNS-01 自动化申请通配符 TLS 证书。',
    dnsProvider: 'DNS 服务商',
    dnsProviderHint:
      '选择托管您域名的 DNS 服务商。全自动通配符证书依赖 DNS-01 验证接口。',
    providerCloudflare: 'Cloudflare',
    providerAlidns: '阿里云 DNS (AliDNS)',
    providerTencentcloud: '腾讯云 DNS',
    dnsToken: 'Cloudflare API 令牌',
    dnsTokenHint:
      '需要对应托管区域的「Zone - Zone:Read」和「Zone - DNS:Edit」权限，并非 Cloudflare 登录密码。',
    aliyunKeyId: 'AccessKey ID',
    aliyunKeyIdHint:
      '具备 AlidnsFullAccess 权限的阿里云 RAM 子用户 AccessKey ID。',
    aliyunKeySecret: 'AccessKey Secret',
    aliyunKeySecretHint: '阿里云 RAM 子用户 AccessKey Secret。',
    tencentSecretId: 'SecretId',
    tencentSecretIdHint:
      '具备 DNSPod / 云解析 DNS 权限的腾讯云 CAM 访问密钥 SecretId。',
    tencentSecretKey: 'SecretKey',
    tencentSecretKeyHint: '腾讯云 CAM 访问密钥 SecretKey。',

    // Section 4: Advanced
    advanced: '高级配置',
    database: '数据库名称',
    databaseUser: '数据库用户',
    databaseHint:
      'PostgreSQL、数据库迁移服务与应用共用这些标识。已有数据时请勿随意更改。',
    image: '镜像版本',
    imageHint:
      '默认使用 v0.1.0-alpha.0 发布镜像，支持 amd64 和 arm64。应用和迁移服务必须使用同一镜像，也可填写本地构建的镜像。',

    // Output & Checklist
    checklist: '部署步骤',
    copy: '复制配置',
    download: '下载配置',
    invalidTitle: '配置未填完整',
    invalidHint: '请完善左侧所有必填项后查看实时 YAML 预览并下载。',
    live: '实时配置预览',
    loading: '正在加载部署模板…',
    privacy: '所有配置在浏览器本地生成，绝不上传或记录任何密钥信息。',
    exportWarning: '导出的 compose.yaml 包含真实明文凭据，请严格做好私密保存。',
    templateError: '模板加载失败或结构不兼容，请刷新重试。',
    copied: '已复制完整 compose.yaml（含凭据），使用后请注意清理剪贴板。',
    clipboardError: '当前浏览器环境无法访问剪贴板，请直接点击下载。',
    downloaded: '已成功下载 compose.yaml。',
    dnsStep: '1. DNS 记录配置',
    dnsHint:
      '将服务域名 A/AAAA 记录解析到服务器（仅 DNS / 关闭 CDN 代理），并添加以下 SRV 记录：',
    portsStep: '2. 网络与端口映射',
    portsHint:
      '在路由器或防火墙中映射对应端口。UDP 端口用于 HTTP/3。请检查回程路由与管理网络隔离。',
    startStep: '3. 启动服务',
    startHint: '在服务器上创建私有目录并保存为 compose.yaml，然后执行启动：',
    verifyStep: '4. 运行验证',
    verifyHint:
      '从外网环境测试访问服务接口，并验证联邦双向发现是否正常。定期备份数据库与 data 目录。',
  },
};

export const issueMessages: Record<string, [string, string]> = {
  domain: [
    '身份域名须为小写主机名，不含协议和端口。',
    'Identity domain must be a lowercase hostname without scheme or port.',
  ],
  webDomain: [
    '服务域名须为小写主机名，不含协议和端口。',
    'Server hostname must be a lowercase hostname without scheme or port.',
  ],
  lanDomain: ['内网域名格式不正确。', 'Invalid LAN hostname.'],
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
  databasePassword: [
    '数据库密码至少需要 16 个字符。',
    'Database password needs at least 16 characters.',
  ],
  adminPassword: [
    '管理员密码至少需要 16 个字符。',
    'Admin password needs at least 16 characters.',
  ],
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
