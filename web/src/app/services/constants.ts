// HTTP base: same-origin relative path (dev via angular proxy /api → :3000; prod same-origin path-prefix).
export const apiPrefix = '/api/v1'
// SSE downlink endpoint (GET /api/v1/events, Bearer header auth).
export const sseUrl = `${apiPrefix}/events`
