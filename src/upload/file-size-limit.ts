import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** Object admission failure, independent of daily usage or transport health. */
export class FileSizeLimitError extends BusinessException {
  constructor(maxFileBytes: number, declaredBytes: number) {
    super(
      BusinessCode.FILE_TOO_LARGE,
      'file exceeds the maximum attachment size',
      undefined,
      {
        maxFileBytes,
        declaredBytes,
      },
    );
  }

  static assert(bytes: number, limit: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid file size',
      );
    }
    if (limit === 0 || bytes > limit)
      throw new FileSizeLimitError(limit, bytes);
  }
}
