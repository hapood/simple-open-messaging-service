import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '../prisma/generated/client.js';
import type { FastifyReply } from 'fastify';
import { BusinessCode } from './business-code.js';
import { BusinessException } from './business.exception.js';

/**
 * 全局异常过滤器：所有异常统一转 { code, message, data } 信封，code 为业务码段（见 business-code.ts）。
 *
 * 业务流原则（P1b）：参数校验等「业务输入失败」纳入业务流 → HTTP 200 + 业务码，
 * 让前端在 success 回调统一按 code 分支（不必分 error/success 两套）。
 * 仅未认证 / 资源不存在 / 冲突 / 服务器异常 这类协议·系统层保留 HTTP 状态码给大类。
 *
 * - ValidationPipe 的 BadRequestException（字段级 message 数组）→ HTTP 200 + VALIDATION_FAILED
 * - 其它 HttpException → 沿用其 HTTP 码，code 按 status 映射到 10xxx 段
 * - Prisma 已知错误：P2002(唯一冲突)→409/ALREADY_EXISTS，P2025(记录不存在)→404/NOT_FOUND
 * - 其它未知异常 → 500/INTERNAL；原文仅记服务端日志（结构化日志 + traceId 属 P3）
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

    // Tier by severity: 5xx / unknown → error with stack (real faults stay visible); 4xx
    // (expired token, missing resource, validation) → concise warn with no stack.
    if (httpStatus >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        message,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      // Append the underlying error's own message when it carries more than the mapped envelope —
      // notably the PrismaClientValidationError detail (column/type that failed), which the generic
      // client-facing `message` deliberately omits so it stays debuggable server-side.
      const detail = exception instanceof Error ? exception.message : String(exception);
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
      data: null,
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

      // ValidationPipe 字段级校验错误（message 为数组）→ 纳入业务流：HTTP 200 + VALIDATION_FAILED
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

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            httpStatus: HttpStatus.CONFLICT,
            code: BusinessCode.ALREADY_EXISTS,
            message: 'resource already exists',
          };
        case 'P2025':
          return {
            httpStatus: HttpStatus.NOT_FOUND,
            code: BusinessCode.NOT_FOUND,
            message: 'resource not found',
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      // A mistyped / missing / wrong-shape argument reached Prisma — e.g. a value ValidationPipe didn't
      // coerce (guards read raw req.body pre-pipe) or a service bound a value Prisma can't cast to its
      // column type. This is the SYSTEM-WIDE safety net: without it the error falls through to the
      // generic 500 below, so every type-mismatch anywhere surfaces as an opaque 500. The Prisma message
      // names internal models/fields, so it is logged in full server-side while the client gets a generic
      // VALIDATION_FAILED (see the warn log in `catch`).
      return {
        httpStatus: HttpStatus.BAD_REQUEST,
        code: BusinessCode.VALIDATION_FAILED,
        message: 'invalid request parameters',
      };
    }

    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      code: BusinessCode.INTERNAL,
      message: 'internal error',
    };
  }

  /** HTTP 状态码 → 10xxx 业务码段（协议·系统层错误，HTTP 码保留给大类）。 */
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
