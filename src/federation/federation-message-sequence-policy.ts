import { FEDERATION_THREAD_SEQUENCE_MAX } from './federation-thread-round.constants.js';

export interface PreserveFederationOriginSequence {
  kind: 'PRESERVE_ORIGIN';
  beforeSeq: number;
  throughSeq?: number;
}

export function validatePreservedFederationOriginSequence(
  originSeq: number,
  policy: PreserveFederationOriginSequence,
): number {
  assertThreadSequence(originSeq, 'federated message origin seq');
  assertThreadSequence(policy.beforeSeq, 'reverse before seq');
  if (policy.beforeSeq === 0 || originSeq >= policy.beforeSeq) {
    throw new Error(
      'federated message origin seq must be less than the reverse before cursor',
    );
  }
  if (policy.throughSeq !== undefined) {
    assertThreadSequence(policy.throughSeq, 'reverse through seq');
    if (policy.throughSeq === 0 || policy.throughSeq >= policy.beforeSeq) {
      throw new Error(
        'reverse through seq must be positive and less than its before cursor',
      );
    }
    if (originSeq < policy.throughSeq) {
      throw new Error(
        'federated message origin seq must not precede the reverse through cursor',
      );
    }
  }
  return originSeq;
}

function assertThreadSequence(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > FEDERATION_THREAD_SEQUENCE_MAX
  ) {
    throw new Error(
      `${label} must be an integer between 1 and ${FEDERATION_THREAD_SEQUENCE_MAX}`,
    );
  }
}
