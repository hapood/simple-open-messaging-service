export type MediaSource =
  | { kind: 'unmanaged' }
  | { kind: 'message'; digest: string; threadId: number; seq: number };

/** Managed URLs carry the authorizing message, which may differ from a snapshot's display ID. */
export function mediaSource(src: string): MediaSource {
  if (!src.startsWith('/uploads/msg-assets/')) return { kind: 'unmanaged' };
  const match =
    /^\/uploads\/msg-assets\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\?threadId=([1-9][0-9]*)&seq=([1-9][0-9]*)$/.exec(
      src,
    );
  if (!match || !match[3].startsWith(match[1] + match[2])) {
    throw new Error('Managed media requires a canonical authorized URL');
  }
  const threadId = Number(match[4]);
  const seq = Number(match[5]);
  if (!Number.isSafeInteger(threadId) || !Number.isSafeInteger(seq)) {
    throw new Error('Managed media coordinates exceed the safe integer range');
  }
  return { kind: 'message', digest: match[3], threadId, seq };
}
