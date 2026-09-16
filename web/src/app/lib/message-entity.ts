interface MessageTextSegment {
  kind: 'text';
  text: string;
}

interface MessageEntitySegment {
  kind: 'entity';
  raw: string;
  sigil: '@';
  label: string;
  entityType: 'user' | 'audience';
  entityId: string;
}

type MessageSegment = MessageTextSegment | MessageEntitySegment;

export const ALL_MENTION_ID = 'somfp:audience:all';

interface ParsedAt {
  entity: MessageEntitySegment;
  end: number;
}

export function serializeUserMention(label: string, account: string): string {
  if (!label) throw new Error('mention label must not be empty');
  if (!account) throw new Error('mention account must not be empty');
  return `[@${escapeLabel(label)}](somfp://user/${encodeURIComponent(account)})`;
}

export function serializeAudienceMention(
  label: string,
  audience: 'all',
): string {
  if (!label) throw new Error('mention label must not be empty');
  return `[@${escapeLabel(label)}](somfp://audience/${audience})`;
}

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

export function toDisplayText(content: string): string {
  return parseMessageEntities(content)
    .map((segment) =>
      segment.kind === 'text'
        ? segment.text
        : `${segment.sigil}${segment.label}`,
    )
    .join('');
}

export interface RenderMessageEntities {
  segments: Array<
    | MessageTextSegment
    | {
        kind: 'mention';
        text: string;
        target: 'me' | 'other' | 'all';
        account?: string;
      }
  >;
  mentionState: 'none' | 'me' | 'all';
}

/** Builds safe render segments and compares stable accounts rather than mutable display labels. */
export function toRenderMessageEntities(
  content: string,
  selfAccount?: string | null,
): RenderMessageEntities {
  const normalizedSelf = selfAccount?.trim().toLocaleLowerCase() ?? '';
  let mentionState: RenderMessageEntities['mentionState'] = 'none';
  const segments: RenderMessageEntities['segments'] = [];

  for (const segment of parseMessageEntities(content)) {
    if (segment.kind === 'text') {
      segments.push(segment);
    } else if (segment.entityType === 'user' && segment.entityId) {
      const isMe =
        !!normalizedSelf &&
        segment.entityId.trim().toLocaleLowerCase() === normalizedSelf;
      if (isMe) mentionState = 'me';
      segments.push({
        kind: 'mention',
        text: `${segment.sigil}${segment.label}`,
        target: isMe ? 'me' : 'other',
        account: segment.entityId,
      });
    } else if (
      segment.entityType === 'audience' &&
      segment.entityId === 'all'
    ) {
      if (mentionState !== 'me') mentionState = 'all';
      segments.push({
        kind: 'mention',
        text: `${segment.sigil}${segment.label}`,
        target: 'all',
      });
    } else {
      segments.push({ kind: 'text', text: `${segment.sigil}${segment.label}` });
    }
  }
  return { segments, mentionState };
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
