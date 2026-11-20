export type UploadProgressHandler = (loaded: number, total: number) => void;
export type UploadPartIntent = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

/** Stable server identity. Progress is advisory; only server offsets authorize resumed writes. */
export interface UploadPartIdentity {
  clientMessageId: string;
  partId: string;
  position: number;
  intent: UploadPartIntent;
}
