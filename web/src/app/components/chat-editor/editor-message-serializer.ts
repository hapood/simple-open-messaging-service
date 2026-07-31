import {
  ALL_MENTION_ID,
  escapePlainText,
  serializeAudienceMention,
  serializeUserMention,
} from '../../lib/message-entity';

export interface EditorJsonNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: EditorJsonNode[];
}

export interface NativeMentionRange {
  start: number;
  end: number;
  kind: 'user' | 'all';
  id: string;
  label: string;
}

/** Convert Tiptap JSON blocks into canonical Message.content. */
export function serializeEditorBlocks(blocks: EditorJsonNode[]): string {
  return blocks.map((block) => serializeInline(block.content ?? [])).join('\n');
}

/** Convert Android EditText UTF-16 ranges into canonical Message.content. */
export function serializeNativeComposerText(
  text: string,
  ranges: readonly NativeMentionRange[],
): string {
  let cursor = 0;
  let out = '';
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  for (const range of ordered) {
    if (
      range.start < cursor ||
      range.end <= range.start ||
      range.end > text.length ||
      text.slice(range.start, range.end) !== `@${range.label}`
    ) {
      continue;
    }
    out += escapePlainText(text.slice(cursor, range.start));
    out +=
      range.kind === 'all' && range.id === ALL_MENTION_ID
        ? serializeAudienceMention(range.label, 'all')
        : serializeUserMention(range.label, range.id);
    cursor = range.end;
  }
  return out + escapePlainText(text.slice(cursor));
}

function serializeInline(nodes: EditorJsonNode[]): string {
  let out = '';
  let plain = '';
  const flushPlain = () => {
    if (!plain) return;
    out += escapePlainText(plain);
    plain = '';
  };

  for (const node of nodes) {
    if (node.type === 'mention') {
      flushPlain();
      const id = typeof node.attrs?.['id'] === 'string' ? node.attrs['id'] : '';
      const label =
        typeof node.attrs?.['label'] === 'string' ? node.attrs['label'] : '';
      if (id === ALL_MENTION_ID && label) {
        out += serializeAudienceMention(label, 'all');
      } else if (id && label) {
        out += serializeUserMention(label, id);
      } else {
        plain += label ? `@${label}` : '';
      }
      continue;
    }
    if (node.type === 'hardBreak') {
      plain += '\n';
      continue;
    }
    if (typeof node.text === 'string') plain += node.text;
    if (node.content) {
      flushPlain();
      out += serializeInline(node.content);
    }
  }
  flushPlain();
  return out;
}
