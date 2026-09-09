import { parseCallEndedContent } from './call-ended-content.js';
import { parseTextMessageContent } from './text-message-content.js';

export const MESSAGE_PREVIEW_MAX_LENGTH = 200;

type DisplayText = (text: string) => string;

/**
 * Derive the stable, unlocalized conversation-list preview for persisted message content.
 * This module is consumed directly by both the API and Web client so newly introduced content
 * types cannot drift between server-hydrated and local-first previews.
 */
export function deriveMessagePreview(
  contentType: string,
  content: string,
  toDisplayText: DisplayText = (text) => text,
): string {
  switch (contentType) {
    case 'PURE_TEXT':
      return toDisplayText(parseTextMessageContent(content)?.text ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MESSAGE_PREVIEW_MAX_LENGTH);
    case 'LINK':
      return linkPreview(content);
    case 'CONTACT_CARD':
      return contactCardPreview(content);
    case 'IMAGE':
      return '[Photo]';
    case 'SYSTEM':
      return parseCallEndedContent(content) ? callPreview(content) : '[System message]';
    case 'VIDEO':
      return '[Video]';
    case 'FILE':
      return '[File]';
    case 'AUDIO':
      return '[Voice message]';
    case 'GALLERY':
      return fileSetPreview(content);
    case 'FORWARD':
      return forwardPreview(content);
    default:
      return content.slice(0, MESSAGE_PREVIEW_MAX_LENGTH);
  }
}

function contactCardPreview(content: string): string {
  try {
    const value = JSON.parse(content) as { displayName?: unknown };
    const name =
      typeof value.displayName === 'string' ? value.displayName.trim() : '';
    return name ? `[Contact] ${name}` : '[Contact]';
  } catch {
    return '[Contact]';
  }
}

function linkPreview(content: string): string {
  try {
    const value = JSON.parse(content) as {
      title?: unknown;
      description?: unknown;
      url?: unknown;
    };
    const preview =
      (typeof value.title === 'string' && value.title.trim()
        ? value.title
        : undefined) ??
      (typeof value.description === 'string' && value.description.trim()
        ? value.description
        : undefined) ??
      (typeof value.url === 'string' ? value.url : content);
    return preview
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MESSAGE_PREVIEW_MAX_LENGTH);
  } catch {
    return content.slice(0, MESSAGE_PREVIEW_MAX_LENGTH);
  }
}

function fileSetPreview(content: string): string {
  try {
    const value = JSON.parse(content) as {
      items?: Array<{ kind?: unknown }>;
    };
    if (!value.items?.length) return '[File set]';
    return `[File set · ${value.items.length}]`;
  } catch {
    return '[File set]';
  }
}

function forwardPreview(content: string): string {
  try {
    const value = JSON.parse(content) as { summaryLines?: unknown };
    const first = Array.isArray(value.summaryLines)
      ? value.summaryLines.find(
          (line): line is string => typeof line === 'string',
        )
      : undefined;
    const summary = first?.replace(/\s+/g, ' ').trim();
    return summary
      ? `[Chat history] ${summary}`.slice(0, MESSAGE_PREVIEW_MAX_LENGTH)
      : '[Chat history]';
  } catch {
    return '[Chat history]';
  }
}

function callPreview(content: string): string {
  try {
    switch ((JSON.parse(content) as { outcome?: unknown }).outcome) {
      case 'missed':
        return '[Missed call]';
      case 'failed':
        return '[Call failed]';
      case 'unreachable':
        return '[Call unreachable]';
      case 'declined':
        return '[Call declined]';
      case 'cancelled':
        return '[Call cancelled]';
      default:
        return '[Call]';
    }
  } catch {
    return '[Call]';
  }
}
