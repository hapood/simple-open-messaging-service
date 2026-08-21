// Federated media localize status values — the stable wire format (backend serializeBody + MEDIA_STATUS
// SSE frame + the attachMediaStatus query field carry these exact strings). Defined here (the components
// SoT) mirroring services/model.ts (the services SoT) — same strings, the wire contract. A const object so
// every reference is MEDIA_STATUS.READY (typed + refactor-safe), not a bare literal. 'ready' = bytes local
// + authz (URL serves 200); 'failed' = localize failed (URL 4xx, retryable); 'downloading' = localize in
// flight (a client-side optimistic state only — the backend stores/pushes the 'ready'|'failed' terminals).
export const MEDIA_STATUS = {
  READY: 'ready',
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

/** Legacy alias — gallery-viewer and older call sites still reference AlbumImage. */
export type AlbumImage = AlbumMedia;

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
export interface ChatMsgData {
  type: 'msg';
  /** = Message.id (virtual-scroll track key + WS/pagination dedup). */
  msgId: number;
  /** Sender userId (classifyGroupFlags keys group-start off this). */
  creator: number;
  /** = creator === current user's userId. */
  isSelf: boolean;
  /** Sender labels are useful in group chats but redundant beside avatars in a direct conversation. */
  isGroupConversation?: boolean;
  /** Sender display name (profile.account; filled for self too — template decides via showName). */
  name: string;
  /** Cached sender profile data used by message-card avatars, including offline opens. */
  avatar?: string;
  avatarIdentityId?: number;
  /** Stable sender account used with avatarDomain for deterministic fallback colors. */
  avatarAccount?: string;
  /** Sender home domain; non-empty for federated identities and drives the avatar globe marker. */
  avatarDomain?: string;
  /** PURE_TEXT body / fallback text for unsupported types. */
  text: string;
  /** Canonical inline-entity storage string for an optimistic PURE_TEXT send. The bubble renders `text`;
   *  HTTP/retry sends this value. Real queried messages need no copy because their wire body is durable. */
  wireText?: string;
  quote?: {
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
  contentType:
    | 'PURE_TEXT'
    | 'IMAGE'
    | 'VIDEO'
    | 'FILE'
    | 'AUDIO'
    | 'GALLERY'
    | 'LINK'
    | 'CALL'
    | 'FORWARD'
    | 'SYSTEM';
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

export type ChatTextSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'mention';
      text: string;
      target: 'me' | 'other' | 'all';
      account?: string;
    };

/**
 * Virtual-scroll item data. The date separator is no longer a data type — the source returns only real
 * messages (ChatMsgData); date separators are derived at createItem mount time by detecting day boundaries
 * between adjacent messages (see date-format.ts). The ChatItemData alias is kept for interface stability.
 */
export type ChatItemData = ChatMsgData;
