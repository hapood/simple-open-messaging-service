/** Measured layout coordinates, before the content's translateY is applied. */
export interface ScrollLayoutRow {
  readonly ids: readonly number[];
  readonly top: number;
  /** Full row height, including attached tail presentation. */
  readonly height: number;
  readonly tailHeight: number;
}

export interface ScrollLayoutSnapshot {
  readonly rows: readonly ScrollLayoutRow[];
  readonly viewportHeight: number;
  readonly scrollTop: number;
  readonly translateY: number;
  readonly totalHeight: number;
  /** Optional pending visual offset; not the currently displayed position. */
  readonly targetOffset?: number;
}

/** Copy scalar measurements and member IDs, retaining no live caller-owned records. */
export function captureScrollLayout(
  layout: ScrollLayoutSnapshot,
): ScrollLayoutSnapshot {
  return Object.freeze({
    rows: Object.freeze(
      layout.rows.map((row) =>
        Object.freeze({
          ids: Object.freeze([...row.ids]),
          top: row.top,
          height: row.height,
          tailHeight: row.tailHeight,
        }),
      ),
    ),
    viewportHeight: layout.viewportHeight,
    scrollTop: layout.scrollTop,
    translateY: layout.translateY,
    totalHeight: layout.totalHeight,
    ...(layout.targetOffset === undefined
      ? {}
      : { targetOffset: layout.targetOffset }),
  });
}

/** A row's screen top is row.top - visualOffset. */
export function visualOffsetOf(layout: ScrollLayoutSnapshot): number {
  return layout.scrollTop - layout.translateY;
}

function messageHeight(row: ScrollLayoutRow): number {
  return Math.max(0, row.height - Math.max(0, row.tailHeight));
}

/**
 * Preserve the old screen top of a surviving message, matching any album member
 * rather than only its head. Choose the surviving old row whose message span is
 * nearest the old viewport center. Ties prefer the earlier old row; split albums
 * prefer the first surviving member in the old row's ID order.
 *
 * The result is deliberately NOT clamped: the caller can represent an out-of-
 * range visual offset using translateY while respecting physical scroll bounds.
 * Tops must include any short-content bottom-alignment inset. No shared member
 * returns null so the caller can snap according to its own policy.
 */
export function compensateScrollLayout(
  before: ScrollLayoutSnapshot,
  after: ScrollLayoutSnapshot,
): number | null {
  const rowsById = new Map<number, ScrollLayoutRow>();
  for (const row of after.rows) {
    for (const id of row.ids) {
      if (!rowsById.has(id)) rowsById.set(id, row);
    }
  }

  const current = visualOffsetOf(before);
  const center = current + before.viewportHeight / 2;
  let bestDistance = Infinity;
  let offset: number | null = null;
  for (const oldRow of before.rows) {
    let newRow: ScrollLayoutRow | undefined;
    for (const id of oldRow.ids) {
      newRow = rowsById.get(id);
      if (newRow) break;
    }
    if (!newRow) continue;
    const distance = Math.max(
      oldRow.top - center,
      center - oldRow.top - messageHeight(oldRow),
      0,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      offset = current + newRow.top - oldRow.top;
    }
  }
  return offset;
}
