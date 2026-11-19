import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** Canonical PostgreSQL bigint identity; never parse through a JavaScript number. */
export function parseUploadTaskId(value: string): bigint {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  ) {
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'invalid upload task id',
    );
  }
  return BigInt(value);
}
