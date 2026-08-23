import type { ChatMsgData } from '../message-cards/chat-item';
import { formatDuration } from '../message-cards/file-meta.util';
import { parseForwardCard } from '../message-cards/forward-row/forward-card';

export interface MessageCopyLabels {
  photo: string;
  video: string;
  voice: string;
  file: string;
  call: string;
  forward: string;
}

/** Media and file cards only have descriptive fallback text, so their context menu does not offer copy. */
export function canCopyMessage(message: ChatMsgData): boolean {
  return !['IMAGE', 'VIDEO', 'AUDIO', 'FILE', 'GALLERY'].includes(
    message.contentType,
  );
}

/** Turn a rendered message into portable plain text without leaking storage URLs or wire JSON. */
export function messageCopyBody(
  message: ChatMsgData,
  labels: MessageCopyLabels,
): string {
  switch (message.contentType) {
    case 'PURE_TEXT':
    case 'LINK':
      return visibleMessageText(message);
    case 'CONTACT_CARD': {
      try {
        const card = JSON.parse(message.text) as {
          account?: unknown;
          domain?: unknown;
        };
        return typeof card.account === 'string' &&
          typeof card.domain === 'string'
          ? `${card.account}@${card.domain}`
          : '';
      } catch {
        return '';
      }
    }
    case 'FILE':
      return joinLabel(labels.file, message.file?.name);
    case 'IMAGE':
    case 'VIDEO':
    case 'AUDIO': {
      const media = message.images?.[0];
      const label =
        message.contentType === 'IMAGE'
          ? labels.photo
          : message.contentType === 'VIDEO'
            ? labels.video
            : labels.voice;
      const detail =
        message.contentType === 'AUDIO'
          ? formatDuration(media?.duration ?? 0)
          : media?.name;
      return joinLabel(label, detail);
    }
    case 'GALLERY':
      return `${labels.photo} × ${message.images?.length ?? 0}`;
    case 'CALL':
      return labels.call;
    case 'SYSTEM':
      return '[System message]';
    case 'FORWARD': {
      const card = parseForwardCard(message.text);
      return joinLabel(
        labels.forward,
        card ? String(card.messageCount) : undefined,
      );
    }
  }
}

/** Build a chronological transcript suitable for pasting outside the application. */
export function selectedMessagesCopyText(
  messages: readonly ChatMsgData[],
  labels: MessageCopyLabels,
): string {
  return messages
    .slice()
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .map(
      (message) =>
        `[${formatCopyTimestamp(message.createdAtMs)}] ${message.name}\n${messageCopyBody(message, labels)}`,
    )
    .join('\n\n');
}

export function formatCopyTimestamp(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function visibleMessageText(message: ChatMsgData): string {
  if (message.textSegments?.length) {
    return message.textSegments
      .map((segment) => segment.text)
      .join('')
      .trim();
  }
  if (!message.rich) return message.text.trim();

  const template = document.createElement('template');
  template.innerHTML = message.text;
  return nodeText(template.content)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof Element) && !(node instanceof DocumentFragment))
    return '';

  let result = '';
  for (const child of Array.from(node.childNodes)) {
    if (child instanceof HTMLBRElement) {
      result += '\n';
      continue;
    }
    const block =
      child instanceof Element &&
      [
        'ADDRESS',
        'BLOCKQUOTE',
        'DIV',
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
        'H6',
        'LI',
        'P',
        'PRE',
      ].includes(child.tagName);
    const text = nodeText(child);
    if (block && result && !result.endsWith('\n')) result += '\n';
    result += text;
    if (block && !result.endsWith('\n')) result += '\n';
  }
  return result;
}

function joinLabel(label: string, detail?: string): string {
  const value = detail?.trim();
  return value ? `${label} ${value}` : label;
}
