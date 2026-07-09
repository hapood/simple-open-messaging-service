/**
 * A single media cell (image / video / audio). layoutAlbum lays out by {w,h}; `src` is used for
 * background-image (image) / <video> first-frame (video) / download anchor (audio). `kind` drives
 * the render branch; size/duration/name feed the bottom meta bar + overlay.
 */
export interface AlbumMedia {
  kind: 'image' | 'video' | 'audio';
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
  /** Owning original msg id (differs across cells in a merged album); layout ignores it, used only
   *  for the dev badge showing the aggregation range `[min-max]`. */
  msgId?: number;
}

/** Legacy alias — gallery-viewer and older call sites still reference AlbumImage. */
export type AlbumImage = AlbumMedia;

/** FILE message attachment: { url, name, size, mimeType } returned by the server's POST /upload/file (stored as JSON inside Message.content). */
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
  /** Sender display name (profile.account; filled for self too — template decides via showName). */
  name: string;
  /** PURE_TEXT body / INVITE JSON source / fallback text for unsupported types. */
  text: string;
  /** Whether the PURE_TEXT body is rich-text HTML (from the Tiptap editor: <strong>/<em>/<code>/@mention chip).
   *  true = render via [innerHTML] (Angular sanitizes automatically); default/false = plain-text {{}} render
   *  (auto-escaped). This split both surfaces the editor's rich text / atomic @chips AND keeps historical /
   *  received plain text containing `<` safely escaped without breaking layout. */
  rich?: boolean;
  /** HH:mm (the date context is handled by the date separator row). */
  time: string;
  contentType: 'PURE_TEXT' | 'INVITE' | 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO';
  /** IMAGE/VIDEO/AUDIO: media cells (consecutive same-creator IMAGE/VIDEO merged into one album). null = non-media. */
  images: AlbumMedia[] | null;
  /** FILE: attachment metadata (url/name/size/mimeType). null = non-file. */
  file: FileInfo | null;
  /** Raw epoch milliseconds (drives date-separator decisions). */
  createdAtMs: number;
  /** Delivery state for self-sent messages, rendered as a status tick (sending=animated spinner ring, sent=check,
   *  failed=retry glyph — click on the row's retry output re-sends). Absent on received messages (no tick). The kernel
   *  treats this opaquely; only the row component reads it. */
  status?: 'sending' | 'sent' | 'failed';
  /** Why a transient item exists — mirrors the playground insert orchestrator's `type` ('pending' = optimistic in
   *  flight, 'fake' = debug insert). Absent on history messages. Used by the dev badge / debug UI only; the kernel
   *  ignores it (a transient is a transient regardless of kind). */
  kind?: 'pending' | 'fake';
}

/**
 * Virtual-scroll item data. The date separator is no longer a data type — the source returns only real
 * messages (ChatMsgData); date separators are derived at createItem mount time by detecting day boundaries
 * between adjacent messages (see date-format.ts). The ChatItemData alias is kept for interface stability.
 */
export type ChatItemData = ChatMsgData;
