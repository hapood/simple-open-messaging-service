export function threadPreviewLimit(
  raw = process.env.THREAD_PREVIEW_LIMIT,
): number {
  if (raw === undefined) return 5;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error('THREAD_PREVIEW_LIMIT must be a safe positive integer');
  }
  return Number(raw);
}
