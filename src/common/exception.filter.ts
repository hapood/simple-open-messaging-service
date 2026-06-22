import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '../prisma/generated/client';
import { Response } from 'express';

/**
 * 全局异常过滤器：所有异常统一转 { status, message, data } 信封 + 正确 HTTP 码，禁止泄漏堆栈。
 * - HttpException：沿用其状态码与 message（ValidationPipe 的字段级错误为数组则拼接，P1a 起接入）
 * - Prisma 已知错误：P2002(唯一冲突)→409，P2025(记录不存在)→404
 * - 其它未知异常：500 + 'internal error'；原文仅记服务端日志（结构化日志属 P3）
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const { httpStatus, message } = this.map(exception);

    console.error('[AllExceptionsFilter]', exception);

    response.status(httpStatus).json({
      status: 1,
      message,
      data: null,
    });
  }

  private map(exception: unknown): { httpStatus: HttpStatus; message: string } {
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
      return { httpStatus, message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002':
          return {
            httpStatus: HttpStatus.CONFLICT,
            message: 'resource already exists',
          };
        case 'P2025':
          return {
            httpStatus: HttpStatus.NOT_FOUND,
            message: 'resource not found',
          };
      }
    }

    return {
      httpStatus: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'internal error',
    };
  }
}
