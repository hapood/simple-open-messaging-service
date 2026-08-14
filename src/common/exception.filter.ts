import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { BusinessCode } from './business-code.js';
import { BusinessException } from './business.exception.js';
import {
  isPostgresError,
  PG_UNIQUE_VIOLATION,
} from '../database/database-error.js';

/**
 * Global exception filter: every exception is normalized to the { code, message, data } envelope, where
 * `code` is a business-code segment (see business-code.ts).
 *
 * Business-flow principle (P1b): "business input failures" such as parameter validation are folded into
 * the business flow → HTTP 200 + a business code, so the frontend branches uniformly on `code` in its
 * success callback (no separate error/success paths). Only protocol/system-layer outcomes —
 * unauthenticated / not-found / conflict / server-error — retain their HTTP status code for the broad
 * category.
 *
 * - ValidationPipe's BadRequestException (field-level message array) → HTTP 200 + VALIDATION_FAILED
 * - Other HttpException → keeps its HTTP status; code is mapped from the status to the 10xxx segment
 * - PostgreSQL unique violations → 409/ALREADY_EXISTS
 * - Any other unknown exception → 500/INTERNAL; the original message is logged server-side only (pino
 *   structured logs, correlated per-request via the X-Request-Id response header). Surfacing a traceId
 *   field in the response *body* was considered and rejected as unnecessary for a self-hosted service —
 *   the header + logs already bridge a client report to its server logs, and federation cross-server
 *   correlation keys off messageId/originSeq.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // Class logger (not bare console) so Nest's configured log levels gate every tier: 5xx →
  // error, 4xx → warn, client disconnect → debug. Disconnects are therefore silent at the
  // default 'log' level (see main.ts) and surface only under LOG_LEVEL=debug.
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();

    // Client disconnected mid-response (closed socket / aborted stream). Not a server fault and
    // the reply socket is gone, so the send below would be futile. Logged at debug — visible
    // only under LOG_LEVEL=debug — so an SSE/streaming incident stays investigable without
    // burying normal output under routine client churn.
    if (this.isClientDisconnect(exception)) {
      this.logger.debug(
        `client disconnected — ${exception instanceof Error ? exception.message : String(exception)}`,
      );
      return;
    }

    const { httpStatus, code, message } = this.map(exception);

    // A BusinessException may carry a structured `data` payload (e.g. a quota hit's
    // {retryAfter}); surface it on the envelope. All other exceptions → data:null.
    const data =
      exception instanceof BusinessException
        ? ((exception.getResponse() as { data?: unknown }).data ?? null)
        : null;

    // Tier by severity: 5xx / unknown → error with stack (real faults stay visible); 4xx
    // → concise warn with no stack. HTTP 2xx BusinessExceptions are ordinary business outcomes,
    // so they are returned without producing an error/warn log.
    if (httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        message,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (httpStatus >= HttpStatus.BAD_REQUEST) {
      // Append the underlying error's own message when it carries more than the mapped envelope —
      // notably the database validation detail (column/type that failed), which the generic
      // client-facing `message` deliberately omits so it stays debuggable server-side.
      const detail =
        exception instanceof Error ? exception.message : String(exception);
      this.logger.warn(
        `${httpStatus} ${message}${detail && detail !== message ? ` — ${detail}` : ''}`,
      );
    }

    // Reply already started (e.g. error thrown while streaming the body) → a second send would
    // throw; nothing left to do.
    if (response.sent) return;

    response.status(httpStatus).send({
      code,
      message,
      data,
    });
  }

  /**
   * True when the exception is a client-side disconnect (socket reset / aborted stream), i.e. the
   * peer went away — expected over SSE / SPA navigation and carrying no diagnostic value. Matched
   * by `code` so the check is stable across Node's h1/h2 stream-error variants.
   */
  private isClientDisconnect(exception: unknown): boolean {
    const code = (exception as { code?: string } | null | undefined)?.code;
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      code === 'ERR_HTTP2_STREAM_ERROR'
    );
  }

  private map(exception: unknown): {
    httpStatus: HttpStatus;
    code: number;
    message: string;
  } {
    // BusinessException carries a domain code that must reach the client verbatim (HTTP 200 +
    // code by convention); handle it before the generic HttpException branch, which would
    // otherwise derive the code from the HTTP status (FORBIDDEN → 10004, etc.).
    if (exception instanceof BusinessException) {
      const resp = exception.getResponse() as { code: number; message: string };
      return {
        httpStatus: exception.getStatus(),
        code: resp.code,
        message: resp.message,
      };
    }

    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const resp = exception.getResponse();
      const message =
        typeof resp === 'string'
          ? resp
          : (resp as any)?.message
            ? Array.isArray((resp as any).message)
              ? (resp as any).message.join('; ')
              : String((resp as any).message)
            : exception.message;

      // ValidationPipe field-level validation error (message is an array) → folded into the business
      // flow: HTTP 200 + VALIDATION_FAILED
      if (
        httpStatus === HttpStatus.BAD_REQUEST &&
        resp &&
        typeof resp === 'object' &&
        Array.isArray((resp as any).message)
      ) {
        return {
          httpStatus: HttpStatus.OK,
          code: BusinessCode.VALIDATION_FAILED,
          message,
        };
      }

      return {
        httpStatus,
        code: this.httpStatusToBusinessCode(httpStatus),
        message,
      };
    }

    if (isPostgresError(exception) && exception.code === PG_UNIQUE_VIOLATION) {
      return {
        httpStatus: HttpStatus.CONFLICT,
        code: BusinessCode.ALREADY_EXISTS,
        message: 'resource already exists',
      };
    }

    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      code: BusinessCode.INTERNAL,
      message: 'internal error',
    };
  }

  /** HTTP status → 10xxx business-code segment (protocol/system-layer errors; the HTTP code is kept for the broad category). */
  private httpStatusToBusinessCode(status: HttpStatus): number {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return BusinessCode.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return BusinessCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return BusinessCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return BusinessCode.ALREADY_EXISTS;
      case HttpStatus.TOO_MANY_REQUESTS:
        return BusinessCode.RATE_LIMITED;
      case HttpStatus.BAD_REQUEST:
        return BusinessCode.VALIDATION_FAILED;
      default:
        return BusinessCode.INTERNAL;
    }
  }
}
