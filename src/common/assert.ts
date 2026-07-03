import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from './business-code.js';
import { BusinessException } from './business.exception.js';

/**
 * Assert `value` is a positive integer, throwing VALIDATION_FAILED otherwise; returns the value
 * narrowed to `number`.
 *
 * Meant for guards/interceptors that read raw `req.body` BEFORE `ValidationPipe` coerces it: a
 * non-number reaching Prisma's `Int` field throws `PrismaClientValidationError`, which
 * `AllExceptionsFilter` does not map (it only handles `PrismaClientKnownRequestError`), surfacing as
 * an opaque 500. The DTO remains the validation authority for controllers; this is the strict,
 * no-transform gate for pre-pipe reads.
 */
export function assertPositiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      `${name} must be a positive integer`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return value;
}
