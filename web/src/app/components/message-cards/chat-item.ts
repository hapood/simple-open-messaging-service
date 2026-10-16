import type { AvatarDomainSource } from '../user-avatar/model';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';

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

/**
 * A single media cell (image / video / audio). layoutAlbum lays out by {w,h}; `src` is used for
 * background-image (image) / <video> first-frame (video) / download anchor (audio). `kind` drives
 * the render branch; size/duration/name feed the bottom meta bar + overlay.
 */
export interface AlbumMedia {
  kind: 'image' | 'video' | 'audio' | 'file';
  /** /uploads/... URL (image / video / audio). */
  src: string;
  w: number;
  h: number;
  /** Bytes — drives the meta bar (formatBytes). */
  size?: number;
  /** Seconds — drives the video/audio duration overlay (formatDuration). */
  duration?: number;
  /** Display name — video/audio meta bar (images usually omit). */
  name?: string;
  mimeType?: string;
  /** Owning original msg id (differs across cells in a merged album); layout ignores it, used only
   *  for the dev badge showing the aggregation range `[min-max]`. */
  msgId?: number;
  /** Federated localize status of this cell's owning message (the gallery shows a backend retry when
   *  'failed'). Absent = 'ready'. */
  status?: MediaStatus;
}

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
interface ChatMessageBase {
  /** Present only on the transient timeline projection of a persisted server history gap. */
  serverGap?: {
    left: number;
    right: number;
    state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
  };
  /** = Message.id (virtual-scroll track key + WS/pagination dedup). */
  msgId: number;
  threadId?: number;
  /** Whether creator matches the current user's address. */
  isSelf: boolean;
  /** Sender labels are useful in group chats but redundant beside avatars in a direct conversation. */
  isGroupConversation?: boolean;
  /** Sender display name (profile.account; filled for self too — template decides via showName). */
  name: string;
  /** Avatar asset embedded in a forwarded snapshot; ordinary profiles use the pinned avatar profile ref. */
  snapshotAvatarUrl?: string;
  /** Stable sender/profile identity key. Snapshot sources may use bundle-scoped keys. */
  avatarIdentityId?: string;
  /** Stable sender account used with the avatar domain source for deterministic fallback colors. */
  avatarAccount?: string;
  /** Namespace identity or fixed snapshot address, independent of profile resolution. */
  avatarDomainSource?: AvatarDomainSource;
  /** Pinned profile subject facts; the avatar/label components own the demand form. */
  avatarProfile?: AvatarProfileRef;
  /** PURE_TEXT body / fallback text for unsupported types. */
  text: string;
  /** Canonical inline-entity storage string for an optimistic PURE_TEXT send. The bubble renders `text`;
   *  HTTP/retry sends this value. Real queried messages need no copy because their wire body is durable. */
  wireText?: string;
  quote?: {
    /** Federated media localize status; NOT_FOUND renders the not-found fallback. */
    status?: 'PENDING' | 'NOT_FOUND';
    anchor?: import('../../services/history-anchor').HistoryAnchor;
    /** Jump target in the current message source; absent for a display-only snapshot. */
    seq?: number;
    author?: string;
    body?: string;
    contentType?: ChatMsgData['contentType'];
    image?: string;
    imageLabel?: string;
    imageIdentity?: string;
    imageSize?: number;
    imageShape?: 'thumbnail' | 'avatar';
  };
  /** Parsed PURE_TEXT body. Stable mention identity is retained for recipient-relative rendering. */
  textSegments?: ChatTextSegment[];
  /** `me` is a direct account match; `all` is the group-wide audience. */
  mentionState?: 'none' | 'me' | 'all';
  /** Whether the PURE_TEXT body is rich-text HTML (from the Tiptap editor: <strong>/<em>/<code>/@mention chip).
   *  true = render via [innerHTML] (Angular sanitizes automatically); default/false = plain-text {{}} render
   *  (auto-escaped). This split both surfaces the editor's rich text / atomic @chips AND keeps historical /
   *  received plain text containing `<` safely escaped without breaking layout. */
  rich?: boolean;
  /** HH:mm (the date context is handled by the date separator row). */
  time: string;
  /** IMAGE/VIDEO/AUDIO: media cells (consecutive same-creator IMAGE/VIDEO merged into one album). null = non-media. */
  images: AlbumMedia[] | null;
  /** FILE: attachment metadata (url/name/size/mimeType). null = non-file. */
  file: FileInfo | null;

  /** Federated media localize status (IMAGE/FILE/VIDEO/AUDIO). Absent = 'ready' (local upload, or
   *  already-localized federated media). 'downloading' = localize in flight (overlay spinner);
   *  'failed' = localize failed (overlay icon + a retry in the detail view). */
  mediaStatus?: MediaStatus;
  /** Raw epoch milliseconds (drives date-separator decisions). */
  createdAtMs: number;
  /** Delivery state for self-sent messages. `sending` is still cancellable; `accepted` means the HTTP request
   *  succeeded and keeps the spinner visible while awaiting the push echo; `sent` is the echoed server row and
   *  renders the check; `failed` exposes retry. Absent on received messages. */
  status?: 'sending' | 'accepted' | 'sent' | 'failed';
  /** Why a transient item exists — mirrors the playground insert orchestrator's `type` ('pending' = optimistic in
   *  flight, 'fake' = debug insert). Absent on history messages. Used by the dev badge / debug UI only; the kernel
   *  ignores it (a transient is a transient regardless of kind). */
  kind?: 'pending' | 'fake';
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

/** A user-authored message always carries a fully resolved User identity key. */
export interface AuthoredMessageItem extends ChatMessageBase {
  type: 'msg';
  creator: string;
  contentType: AuthoredContentType;
}

/** A $system@local notification; event participants live in its content. */
export interface SystemMessageItem extends ChatMessageBase {
  type: 'system';
  contentType: 'SYSTEM';
  /** Local-only per-participant revision corrections from this cached message row. */
  localSystemProfileRevs?: Record<string, number>;
  /** Presentation of a retained message coordinate whose body was erased. */
  deletionType?: 'USER_RETRACTION' | 'MODERATION_REMOVAL';
}

export type ChatMsgData = AuthoredMessageItem | SystemMessageItem;

/** A row bound to a real server seq. Optimistic sends carry synthetic negative
 *  placeholder ids (see ThreadSendOutboxService.allocatePlaceholderId) until the
 *  server echo replaces them, so every seq-dependent capability (quote, direct
 *  forward, multi-select/history-forward, withdraw, report) must gate on this.
 *  Copy stays available on pending rows: it needs only local data. */
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
 * Virtual-scroll item data. Durable authored/system messages and tombstone placeholders all project to
 * ChatMsgData; date separators are derived at createItem mount time by detecting day boundaries between
 * adjacent items (see date-format.ts). The ChatItemData alias is kept for interface stability.
 */
export type ChatItemData = ChatMsgData;
