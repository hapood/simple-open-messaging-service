/**
 * 读取必填环境变量，缺失则抛错（fail-fast：服务不应在缺配置时启动）。
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

/**
 * 解析 CORS origin 白名单（逗号分隔）。
 * 未配置时回退到开发默认（前端 ng serve 端口）；生产环境必须显式配置 CORS_ORIGIN。
 */
export function parseCorsOrigins(raw?: string): string[] {
  if (!raw) {
    return ['http://localhost:4200'];
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
