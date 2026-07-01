/** 相册单张图：layoutAlbum 按 {w,h} 算布局，src 供 background-image 加载。 */
export interface AlbumImage {
  src: string;
  w: number;
  h: number;
  /** 该图所属的原 msg id（相册聚合多 msg 时各图不同）；layout 不读，仅供 dev 角标显聚合范围 `[min-max]`。 */
  msgId?: string;
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
  /** HH:mm（日期上下文交 date 分隔行）。 */
  time: string;
  contentType: 'PURE_TEXT' | 'INVITE' | 'IMAGE' | 'VIDEO' | 'FILE' | 'AUDIO';
  /** IMAGE：相册图片（同发送者连续 IMAGE 已合并为一条）。null=非图片。 */
  images: AlbumImage[] | null;
  /** 原始毫秒（日期分隔判定）。 */
  createdAtMs: number;
  /** Delivery state for self-sent messages, rendered as a status tick (sending=clock, sent=check). Absent on received
   *  messages (no tick). The kernel treats this opaquely; only the row component reads it. */
  status?: 'sending' | 'sent';
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
