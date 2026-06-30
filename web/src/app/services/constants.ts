export const host = `//${location.hostname}:3000`
// HTTP 调用基址（P1b：后端全局路由前缀 /api/v1）
export const apiPrefix = `${host}/api/v1`
// SSE 下行流端点（GET /api/v1/events，Bearer header 鉴权）。
export const sseUrl = `${apiPrefix}/events`
