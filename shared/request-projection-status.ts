/** Presentation state of one request, independent of the relationship intent state. */
export enum RequestProjectionStatus {
  REQUESTED = 'REQUESTED',
  ACCEPTED = 'ACCEPTED',
  WITHDRAWN = 'WITHDRAWN',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

export type RequestProjectionStatusValue = `${RequestProjectionStatus}`;

export type RequestRevocationStatus = 'WITHDRAWN' | 'REJECTED';
