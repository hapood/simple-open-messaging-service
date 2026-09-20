import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** Enforce the storage boundary even for callers that do not pass through HTTP DTOs. */
export function assertGroupNameLength(name: string | undefined): void {
  if (name !== undefined && [...name].length > 31) {
    throw new BusinessException(
      BusinessCode.VALIDATION_FAILED,
      'group name must be at most 31 characters',
    );
  }
}
