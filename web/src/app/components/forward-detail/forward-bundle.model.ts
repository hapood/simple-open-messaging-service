interface ForwardAssetDocument {
  digest: string;
  bytes: number;
}

export interface ForwardManifestMessage {
  /** Canonical positive bundle-local message id. */
  id: number;
  profile: {
    displayName: string;
    avatarDigest?: string;
  };
  contentType: string;
  content: string;
  sentAt: number;
  childBundleId?: string;
  quoteTargetId?: number;
}

export interface ForwardWireChild {
  id: string;
  messages: ForwardManifestMessage[];
}

export interface ForwardWireBundle extends ForwardWireChild {
  children: ForwardWireChild[];
  assets: ForwardAssetDocument[];
  accessContext: { threadId: number; seq: number };
}
