export interface ForwardCard {
  bundleId: string;
  summaryLines: string[];
  messageCount: number;
}

export function parseForwardCard(content: string): ForwardCard | null {
  try {
    const value: unknown = JSON.parse(content);
    if (
      !value ||
      typeof value !== 'object' ||
      !('bundleId' in value) ||
      typeof value.bundleId !== 'string' ||
      !('summaryLines' in value) ||
      !Array.isArray(value.summaryLines) ||
      !value.summaryLines.every((line) => typeof line === 'string') ||
      !('messageCount' in value) ||
      typeof value.messageCount !== 'number' ||
      !Number.isSafeInteger(value.messageCount) ||
      value.messageCount < 0
    ) {
      return null;
    }
    return {
      bundleId: value.bundleId,
      summaryLines: value.summaryLines,
      messageCount: value.messageCount,
    };
  } catch {
    return null;
  }
}
