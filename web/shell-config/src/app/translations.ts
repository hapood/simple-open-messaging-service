/**
 * Inline translations for the shell-config bootstrap (en + zh-CN). Statically imported into the bundle —
 * no HTTP fetch, no missing-key window on first paint (the bootstrap runs at first run / reconfigure,
 * possibly against a brand-new server with no /assets/i18n served yet). Mirrors the main app's
 * no-FOUC i18n ethos. Keep the key set small (this UI is ~15 strings) and in lock-step with
 * `ScLoader` + the template's `| transloco` keys.
 */
export const translations: Record<string, Record<string, string>> = {
  en: {
    'sc.title': 'Backend server',
    'sc.hint': 'Point this app at your SOMS backend. Verified once, used on every launch.',
    'sc.placeholder': 'https://soms.example.com:7667',
    'sc.testConnection': 'Test',
    'sc.save': 'Connect',
    'sc.insecure': 'Insecure (http/IP) — certificate validation will be skipped; not guaranteed secure.',
    'sc.step.compat': 'Checking server compatibility…',
    'sc.step.cert': 'Validating certificate…',
    'sc.step.download': 'Downloading and verifying…',
    'sc.step.done': 'Ready — starting the app…',
    'sc.compatErr': 'This app version is not compatible with this server. Update the app.',
    'sc.certErr': 'Certificate check failed (self-signed / expired / unreachable). Use a valid HTTPS domain, or an IP address.',
    'sc.downloadErr': 'Download or integrity check failed. The bundle was not installed.',
    'sc.retry': 'Back',
    'sc.starting': 'Starting…',
  },
  'zh-CN': {
    'sc.title': '后端服务器',
    'sc.hint': '将客户端指向你的 SOMS 后端。校验一次，每次启动使用。',
    'sc.placeholder': 'https://soms.example.com:7667',
    'sc.testConnection': '测试',
    'sc.save': '连接',
    'sc.insecure': '不安全（http/IP）——将跳过证书校验，不保证安全。',
    'sc.step.compat': '正在检查服务器兼容性…',
    'sc.step.cert': '正在校验证书…',
    'sc.step.download': '正在下载并校验…',
    'sc.step.done': '就绪——正在启动应用…',
    'sc.compatErr': '此客户端版本与服务器不兼容，请更新客户端。',
    'sc.certErr': '证书校验失败（自签名/过期/不可达）。请使用受信 HTTPS 域名或 IP 地址。',
    'sc.downloadErr': '下载或完整性校验失败，未安装。',
    'sc.retry': '返回',
    'sc.starting': '启动中…',
  },
};
