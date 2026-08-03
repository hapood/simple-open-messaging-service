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
  sender: {
    displayName: string;
    account: string;
    domain: string;
    avatarDigest?: string;
  };
  contentType: string;
  content: string;
  sentAt: number;
  childBundleId?: string;
  quote?: {
    preview: string;
    targetId?: number;
  };
}

export interface ForwardWireBundle {
  id: string;
  depth: number;
  manifestDigest: string;
  manifest: {
    schemaVersion: 1;
    bundleId: string;
    depth: number;
    children: string[];
    messages: ForwardManifestMessage[];
  };
  assets: ForwardAssetDocument[];
}

export interface ForwardWireClosure {
  schemaVersion: 1;
  rootBundleId: string;
  bundles: ForwardWireBundle[];
  assets: ForwardAssetDocument[];
  accessContext?: { threadId: number; seq: number };
}
