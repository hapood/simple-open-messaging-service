export interface ForwardCard {
  version: 1;
  bundleId: string;
  summaryLines: string[];
  messageCount: number;
  assetCount: number;
}

export function parseForwardCard(content: string): ForwardCard | null {
  try {
    const value: unknown = JSON.parse(content);
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('bundleId' in value) ||
      typeof value.bundleId !== 'string' ||
      !('summaryLines' in value) ||
      !Array.isArray(value.summaryLines) ||
      !value.summaryLines.every((line) => typeof line === 'string') ||
      !('messageCount' in value) ||
      typeof value.messageCount !== 'number' ||
      !Number.isSafeInteger(value.messageCount) ||
      value.messageCount < 0 ||
      !('assetCount' in value) ||
      typeof value.assetCount !== 'number' ||
      !Number.isSafeInteger(value.assetCount) ||
      value.assetCount < 0
    ) {
      return null;
    }
    return {
      version: 1,
      bundleId: value.bundleId,
      summaryLines: value.summaryLines,
      messageCount: value.messageCount,
      assetCount: value.assetCount,
    };
  } catch {
    return null;
  }
}
