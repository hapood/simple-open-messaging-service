import type { ContentType } from '../database/enums.js';

type FederatedContentType = Exclude<ContentType, 'SYSTEM'>;

export interface FederationAuthorAddress {
  account: string;
  /** Profile-subject namespace in the authenticated publisher's namespace space. */
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
}
