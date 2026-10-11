import type { ContentType } from '../database/enums.js';

type FederatedContentType = Exclude<ContentType, 'SYSTEM'>;

export interface FederationAuthorAddress {
  account: string;
  /** Author home in the message publisher's namespace space. */
  namespaceId: number;
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
  /** Payload digest of the quoted message, stable across federation hops. */
  quoteDigest?: string;
}
