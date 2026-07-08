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
  msgId?: string;
}

/** Legacy alias — gallery-viewer and older call sites still reference AlbumImage. */
export type AlbumImage = AlbumMedia;

/** FILE 消息附件：服务端 POST /upload/file 返回的 { url, name, size, mimeType }（存于 Message.content 的 JSON）。 */
export interface FileInfo {
  /** 服务端相对 URL（/uploads/<name>），FileRow 的下载锚点 href。 */
  url: string;
  /** 安全化后的展示文件名。 */
  name: string;
  /** 字节数（卡片渲染为可读大小）。 */
  size: number;
  /** 校验过的 mimetype（决定文件类型图标）。 */
  mimeType: string;
}

/**
 * 已解析、可渲染的消息数据。HttpItemSource 把后端 Message 翻成它。
 *
 * 不含 isShowHead/isGroupStart——分组标在 createItem 渲染时按上一条算
 *（classifyGroupFlags），这样 append 新消息时旧末条高度不变、零 reflow。
 */
export interface ChatMsgData {
  type: 'msg';
  /** = Message.id（虚拟滚动 track key + WS/分页去重）。 */
  msgId: string;
  /** 发送者 userId（classifyGroupFlags 按它判组首）。 */
  creator: number;
  /** = creator === 当前用户 userId。 */
  isSelf: boolean;
  /** 发送者显示名（profile.uniqName；self 也填，模板按 showName 决定显不显）。 */
  name: string;
  /** PURE_TEXT 正文 / INVITE 的 JSON 原文 / 未支持类型兜底文本。 */
  text: string;
  /** PURE_TEXT 是否为富文本 HTML（来自 Tiptap 编辑器：含 <strong>/<em>/<code>/@mention chip）。
   *  true=用 [innerHTML] 渲染（Angular 自动 sanitize）；缺省/false=纯文本 {{}} 渲染（自动转义）。
   *  这样区分既能展示编辑器的富文本/原子 @chip，又让含 `<` 的历史/收到的纯文本安全转义不破。 */
  rich?: boolean;
  /** HH:mm（日期上下文交 date 分隔行）。 */
  time: string;
  contentType: 'PURE_TEXT' | 'INVITE' | 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO';
  /** IMAGE/VIDEO/AUDIO: media cells (consecutive same-creator IMAGE/VIDEO merged into one album). null = non-media. */
  images: AlbumMedia[] | null;
  /** FILE：附件元信息（url/name/size/mimeType）。null=非文件。 */
  file: FileInfo | null;
  /** 原始毫秒（日期分隔判定）。 */
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
 * 虚拟滚动 item 数据。date 分隔不再是一种数据类型——source 只返回真实消息（ChatMsgData），
 * date 由 createItem 工厂挂载时按相邻消息跨日判定派生（见 date-format.ts）。保留 ChatItemData 别名以稳接口。
 */
export type ChatItemData = ChatMsgData;
