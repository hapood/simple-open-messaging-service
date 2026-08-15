import type { ContentType } from '../database/enums.js';

export type FederatedContentType = Exclude<ContentType, 'SYSTEM'>;

export interface FederationAddress {
  account: string;
  domain: string;
}

export interface FederationByteDescriptor {
  digest: string;
  bytes: number;
}

/** Common encoded message payload shared by timeline messages and forward manifests. */
export interface FederatedMessagePayload<
  TContentType extends string = FederatedContentType,
> {
  contentType: TContentType;
  content: string;
}
