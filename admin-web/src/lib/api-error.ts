/**
 * 业务错误：由 request()/postPublic() 在 ApiResult.code !== 0 时抛出，
 * 携带业务码（对齐 CODE 常量）与原始 HTTP 状态。供 UI 与 query-client 统一识别。
 */
export class ApiError extends Error {
  code: number
  httpStatus: number
  constructor(code: number, message: string, httpStatus: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
