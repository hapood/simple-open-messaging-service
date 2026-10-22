/**
 * Business error: thrown by request()/postPublic() when ApiResult.code !== 0, carrying
 * the business code (aligned with the CODE constants) and the original HTTP status.
 * Used for unified recognition by the UI and query-client.
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
