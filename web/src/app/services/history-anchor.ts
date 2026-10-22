/** External origin coordinates are selectors, never timeline cursors or cache keys. */
export type HistoryAnchor =
  | { kind: 'local'; seq: number }
  | {
      kind: 'origin';
      namespaceId: number;
      originSeq: number;
      localSeq?: number;
    };

export function historyAnchorRequest(
  anchor: HistoryAnchor,
):
  | { anchorSeq: number }
  | { anchorNamespaceId: number; anchorOriginSeq: number } {
  return anchor.kind === 'local'
    ? { anchorSeq: anchor.seq }
    : {
        anchorNamespaceId: anchor.namespaceId,
        anchorOriginSeq: anchor.originSeq,
      };
}
