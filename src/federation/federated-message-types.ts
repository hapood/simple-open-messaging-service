import type { ContentType } from '../database/enums.js';

type FederatedContentType = Exclude<ContentType, 'SYSTEM'>;

export interface FederationAuthorAddress {
  account: string;
  /** The configured domain for a publisher-hosted subject; otherwise the retained home domain. */
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
  /** Payload digest of the quoted message, stable across federation hops. */
  quoteDigest?: string;
}
