import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '../prisma/generated/client';
import { Response } from 'express';
import { BusinessCode } from './business-code';

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
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { httpStatus, code, message } = this.map(exception);

    console.error('[AllExceptionsFilter]', exception);

    response.status(httpStatus).json({
      code,
      message,
      data: null,
    });
  }

  private map(exception: unknown): {
    httpStatus: HttpStatus;
    code: number;
    message: string;
  } {
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
