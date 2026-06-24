export const host = `//${location.hostname}:3000`
// HTTP 调用基址（P1b：后端全局路由前缀 /api/v1）
export const apiPrefix = `${host}/api/v1`
// WebSocket 连接地址（根路径；WS 走 WsAdapter，不经 HTTP 路由前缀）
export const wsUrl = host
