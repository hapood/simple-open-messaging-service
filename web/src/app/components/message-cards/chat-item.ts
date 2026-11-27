import type { AvatarSource } from '../user-avatar/avatar-source';
import type { SenderDisplayContext } from './message-sender';

// Federated media localize status values — the stable wire format (backend serializeBody + MEDIA_STATUS
// SSE frame + the attachMediaStatus query field carry these exact strings). Defined here (the components
// SoT) mirroring services/model.ts (the services SoT) — same strings, the wire contract. A const object so
// every reference is MEDIA_STATUS.READY (typed + refactor-safe), not a bare literal. 'ready' = bytes local
// + authz (URL serves 200); 'failed' = localize failed (URL 4xx, retryable); 'downloading' = localize in
// flight (a client-side optimistic state only — the backend stores/pushes the 'ready'|'failed' terminals).
export const MEDIA_STATUS = {
  READY: 'ready',
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  FAILED: 'failed',
} as const;
export type MediaStatus = (typeof MEDIA_STATUS)[keyof typeof MEDIA_STATUS];

/** Required attachment metadata; message attribution is separate from the observed download state. */
interface MediaResourceBase {
  src: string;
  size: number;
  name: string;
  mimeType: string;
  senderName: string | null;
  sentAt: number | null;
  /** Owning message coordinate, independent of the resource's intrinsic metadata. */
  msgId: number;
}

export type ImageMedia = MediaResourceBase & {
  kind: 'image';
  w: number;
  h: number;
};
export type VideoMedia = MediaResourceBase & {
  kind: 'video';
  w: number;
  h: number;
  duration: number;
};
export type AudioMedia = MediaResourceBase & {
  kind: 'audio';
  duration: number;
};
export type FileMedia = MediaResourceBase & { kind: 'file' };

/** Nonvisual resources have no pixel dimensions; only playable media have a duration. */
export type AlbumMedia = ImageMedia | VideoMedia | AudioMedia | FileMedia;

/** FILE message attachment returned by the server's unified upload endpoint (stored as JSON inside Message.content). */
export interface FileInfo {
  /** Server-relative URL (/uploads/<name>); the FileRow download anchor's href. */
  url: string;
  /** Sanitized display file name. */
  name: string;
  /** Size in bytes (rendered as a human-readable size by the card). */
  size: number;
  /** Validated mimetype (drives the file-type icon). */
  mimeType: string;
}

/**
 * Parsed, render-ready message data. HttpItemSource translates a backend Message into this.
 *
 * Deliberately omits isShowHead/isGroupStart — grouping flags are computed at createItem render
 * time against the previous message (classifyGroupFlags), so appending a new message never
 * changes the old tail item's height (zero reflow).
 */
export interface QuotePresentation {
  author?: string;
  body?: string;
  contentType?: ChatMsgData['contentType'];
  image?: string;
  imageLabel?: string;
  imageIdentity?: string;
  imageSize?: number;
  imageShape?: 'thumbnail' | 'avatar';
}

export type MessageQuote =
  | {
      kind: 'unavailable';
      status: 'PENDING' | 'NOT_FOUND';
      seq?: number;
    }
  | ({
      kind: 'jumpable';
      anchor?: import('../../services/history-anchor').HistoryAnchor;
      seq?: number;
    } & QuotePresentation)
  | ({
      kind: 'snapshot';
    } & QuotePresentation);

interface ChatMessageBase {
  /** = Message.id (virtual-scroll track key + WS/pagination dedup). */
  msgId: number;
  threadId?: number;
  /** Whether creator matches the current user's address. */
  isSelf: boolean;
  /** Business thread context for mentions and system-message interpretation, not sender-label policy. */
  isGroupConversation?: boolean;
  /** Surface policy, independent of identity and message content type. */
  senderDisplayContext?: SenderDisplayContext;
  /** Captured sender-name fallback; resolved sender presentation owns the rendered name. */
  name: string;
  /** Mutually exclusive sender source. Missing on system rows and local unprofiled placeholders. */
  sender?: AvatarSource;
  /** Stable sender/profile presentation key, never inferred from display data. */
  avatarIdentityId?: string;
  /** PURE_TEXT body / fallback text for unsupported types. */
  text: string;
  quote?: MessageQuote;
  /** HH:mm (the date context is handled by the date separator row). */
  time: string;
  /** Raw epoch milliseconds (drives date-separator decisions). */
  createdAtMs: number;
  /** Debug-only synthetic history row marker. Sending tasks never use a history row marker. */
  kind?: 'fake';
}

export type AuthoredContentType =
  | 'PURE_TEXT'
  | 'IMAGE'
  | 'VIDEO'
  | 'FILE'
  | 'AUDIO'
  | 'GALLERY'
  | 'LINK'
  | 'CONTACT_CARD'
  | 'FORWARD';

/** Mixed visual albums retain the head message's content type. */
export interface MediaMessageContent {
  contentType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'GALLERY';
  images: AlbumMedia[];
  file: null;
}

export interface FileMessageContent {
  contentType: 'FILE';
  images: null;
  file: FileInfo;
}

interface NoAttachments {
  images: null;
  file: null;
}

export interface TextMessageContent extends NoAttachments {
  contentType: 'PURE_TEXT';
  /** Parsed text with recipient-relative mention identity. Absent on display-only snapshots. */
  textSegments?: ChatTextSegment[];
  mentionState?: 'none' | 'me' | 'all';
  /** HTML rendering is explicit; plain text remains escaped by default. */
  rich?: boolean;
}
export interface LinkMessageContent extends NoAttachments {
  contentType: 'LINK';
}
export interface ContactCardMessageContent extends NoAttachments {
  contentType: 'CONTACT_CARD';
}
export interface ForwardMessageContent extends NoAttachments {
  contentType: 'FORWARD';
}
export type NonAttachmentMessageContent =
  | TextMessageContent
  | LinkMessageContent
  | ContactCardMessageContent
  | ForwardMessageContent;

export type AuthoredMessageContent =
  | MediaMessageContent
  | FileMessageContent
  | NonAttachmentMessageContent;

/** Authored content uses an explicit grouping key; snapshots use independent bundle-local keys. */
interface AuthoredMessageBase extends ChatMessageBase {
  type: 'msg';
  creator: string;
}

export interface MediaMessageItem
  extends AuthoredMessageBase,
    MediaMessageContent {}
export interface FileMessageItem
  extends AuthoredMessageBase,
    FileMessageContent {}
export interface TextMessageItem
  extends AuthoredMessageBase,
    TextMessageContent {}
export interface LinkMessageItem
  extends AuthoredMessageBase,
    LinkMessageContent {}
export interface ContactCardMessageItem
  extends AuthoredMessageBase,
    ContactCardMessageContent {}
export interface ForwardMessageItem
  extends AuthoredMessageBase,
    ForwardMessageContent {}
export type NonAttachmentMessageItem =
  | TextMessageItem
  | LinkMessageItem
  | ContactCardMessageItem
  | ForwardMessageItem;

export type AuthoredMessageItem =
  | MediaMessageItem
  | FileMessageItem
  | NonAttachmentMessageItem;

/** A $system@local notification; event participants live in its content. */
export interface SystemMessageItem extends ChatMessageBase {
  type: 'system';
  contentType: 'SYSTEM';
  images: null;
  file: null;
  /** Local-only per-participant revision corrections from this cached message row. */
  localSystemProfileRevs?: Record<string, number>;
  /** Ephemeral replacement of a mounted message, never reconstructed from persisted deletion stubs. */
  deletionType?: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
}

export interface ServerGapItem {
  type: 'serverGap';
  msgId: number;
  left: number;
  right: number;
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

export type ChatMsgData = AuthoredMessageItem | SystemMessageItem;

/** A row bound to a real server seq. Every seq-dependent capability (quote, direct
 *  forward, multi-select/history-forward, withdraw, report) must gate on this. */
export function isConfirmedMessage(message: ChatMsgData): boolean {
  return message.msgId >= 0;
}

type ChatTextSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'mention';
      text: string;
      target: 'me' | 'other' | 'all';
      account?: string;
    };

/**
 * Virtual-scroll item data. Durable authored/system messages and ephemeral mounted deletion notices project to
 * ChatMsgData; persisted deletion stubs are excluded. Date separators detect day boundaries between
 * adjacent items (see date-format.ts). The ChatItemData alias is kept for interface stability.
 */
export type ChatItemData = ChatMsgData | ServerGapItem;
