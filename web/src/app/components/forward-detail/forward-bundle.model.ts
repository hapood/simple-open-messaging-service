export interface ForwardAssetDocument {
  digest: string;
  kind: 'avatar' | 'image' | 'file' | 'video' | 'audio' | 'link';
  extension: string;
  bytes: number;
  filename?: string;
  mime?: string;
}

export interface ForwardManifestMessage {
  /** Canonical 1-based Bundle-local id; absent only on legacy v1 snapshots. */
  id?: number;
  author: {
    displayName: string;
    account: string;
    domain: string;
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
