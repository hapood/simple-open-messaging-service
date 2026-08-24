export interface MessageTextSegment {
  kind: 'text';
  text: string;
}

export interface MessageEntitySegment {
  kind: 'entity';
  raw: string;
  sigil: '@';
  label: string;
  entityType: 'user' | 'audience';
  entityId: string;
}

export type MessageSegment = MessageTextSegment | MessageEntitySegment;

export const ALL_MENTION_ID = 'somfp:audience:all';

interface ParsedAt {
  entity: MessageEntitySegment;
  end: number;
}

/** Serialize the canonical v1 representation of a user mention. */
export function serializeUserMention(label: string, account: string): string {
  if (!label) throw new Error('mention label must not be empty');
  if (!account) throw new Error('mention account must not be empty');
  return `[@${escapeLabel(label)}](somfp://user/${encodeURIComponent(account)})`;
}

/** Serialize the canonical v1 representation of a group-wide mention. */
export function serializeAudienceMention(
  label: string,
  audience: 'all',
): string {
  if (!label) throw new Error('mention label must not be empty');
  return `[@${escapeLabel(label)}](somfp://audience/${audience})`;
}

/**
 * Encode an editor plain-text node for storage. A complete SOMFP entity typed or
 * pasted as text is escaped at its opening bracket; a real editor entity node
 * bypasses this function and calls its entity serializer instead.
 */
export function escapePlainText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\\') {
      out += '\\\\';
      i++;
      continue;
    }
    if (text[i] === '[' && parseEntityAt(text, i)) {
      out += '\\[';
      i++;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Parse storage content into safe text/entity segments. */
export function parseMessageEntities(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let text = '';

  const flushText = () => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous?.kind === 'text') previous.text += text;
    else segments.push({ kind: 'text', text });
    text = '';
  };

  for (let i = 0; i < content.length; ) {
    if (content[i] === '\\' && content[i + 1] === '\\') {
      text += '\\';
      i += 2;
      continue;
    }
    if (content[i] === '\\' && content[i + 1] === '[') {
      text += '[';
      i += 2;
      continue;
    }
    if (content[i] === '[') {
      const parsed = parseEntityAt(content, i);
      if (parsed) {
        flushText();
        segments.push(parsed.entity);
        i = parsed.end;
        continue;
      }
    }
    text += content[i];
    i++;
  }
  flushText();
  return segments;
}

/** Produce copy/search/preview text without exposing the SOMFP URI. */
export function toDisplayText(content: string): string {
  return parseMessageEntities(content)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : `${segment.sigil}${segment.label}`,
    )
    .join('');
}

/** Rewrite only valid entity tokens while preserving every byte of surrounding/escaped storage text. */
export function transformMessageEntities(
  content: string,
  transform: (entity: MessageEntitySegment) => string,
): string {
  let out = '';
  for (let i = 0; i < content.length; ) {
    if (content[i] === '\\' && content[i + 1] !== undefined) {
      out += content.slice(i, i + 2);
      i += 2;
      continue;
    }
    const parsed = content[i] === '[' ? parseEntityAt(content, i) : null;
    if (parsed) {
      out += transform(parsed.entity);
      i = parsed.end;
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

function parseEntityAt(content: string, start: number): ParsedAt | null {
  if (content[start] !== '[' || content[start + 1] !== '@') {
    return null;
  }

  const sigil = '@';
  const labelResult = readLabel(content, start + 2);
  if (!labelResult || !labelResult.label) return null;
  const uriStart = labelResult.end + 2;
  if (content[labelResult.end + 1] !== '(') return null;
  const closeParen = content.indexOf(')', uriStart);
  if (closeParen < 0) return null;

  const uriText = content.slice(uriStart, closeParen);
  let url: URL;
  try {
    url = new URL(uriText);
  } catch {
    return null;
  }
  if (url.protocol !== 'somfp:' || !url.hostname || url.pathname.length <= 1) {
    return null;
  }
  if (url.search || url.hash || url.port || url.username || url.password)
    return null;

  let entityId: string;
  try {
    entityId = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (!entityId || entityId.includes('/')) return null;

  const entityType =
    url.hostname === 'user'
      ? 'user'
      : url.hostname === 'audience'
        ? 'audience'
        : null;
  const canonical =
    entityType === 'user'
      ? `somfp://user/${encodeURIComponent(entityId)}`
      : entityType === 'audience' && entityId === 'all'
        ? 'somfp://audience/all'
        : null;
  if (entityType === null || canonical === null || uriText !== canonical)
    return null;
  const end = closeParen + 1;
  return {
    entity: {
      kind: 'entity',
      raw: content.slice(start, end),
      sigil,
      label: labelResult.label,
      entityType,
      entityId,
    },
    end,
  };
}

function readLabel(
  content: string,
  start: number,
): { label: string; end: number } | null {
  let label = '';
  for (let i = start; i < content.length; i++) {
    if (content[i] === '\\') {
      const escaped = content[i + 1];
      if (escaped === '\\' || escaped === '[' || escaped === ']') {
        label += escaped;
        i++;
        continue;
      }
      label += '\\';
      continue;
    }
    if (content[i] === ']') return { label, end: i };
    label += content[i];
  }
  return null;
}

function escapeLabel(label: string): string {
  return label.replace(/[\\[\]]/g, '\\$&');
}
