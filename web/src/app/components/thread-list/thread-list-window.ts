export const THREAD_ROW_HEIGHT = 72;
const BUFFER_ROWS = 6;

/** Fixed-height geometry; neither transforms nor animated row boxes are measured. */
export function threadListWindow(
  count: number,
  viewportHeight: number,
  scrollTop: number,
) {
  const totalHeight = count * THREAD_ROW_HEIGHT;
  const height = Math.max(0, Math.floor(viewportHeight));
  const offset = Math.max(
    0,
    Math.min(Math.floor(scrollTop), Math.max(0, totalHeight - height)),
  );
  const start = Math.max(
    0,
    Math.floor(offset / THREAD_ROW_HEIGHT) - BUFFER_ROWS,
  );
  const end = Math.min(
    count,
    Math.ceil((offset + height) / THREAD_ROW_HEIGHT) + BUFFER_ROWS,
  );
  return {
    start,
    end,
    scrollTop: offset,
    translateY: start * THREAD_ROW_HEIGHT,
    totalHeight,
  };
}
