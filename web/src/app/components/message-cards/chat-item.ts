/** 相册单张图：layoutAlbum 按 {w,h} 算布局，src 供 background-image 加载。 */
export interface AlbumImage {
  src: string;
  w: number;
  h: number;
}

/**
 * 已解析、可渲染的消息数据。ChatThreadController 把后端 Message 翻成它。
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
}

export interface ChatDateData {
  type: 'date';
  /** 今天/昨天/周X/M月D日/YYYY年M月D日。 */
  label: string;
  /** YYYY-MM-DD（跨天分隔判定）。 */
  dayKey: string;
}

export type ChatItemData = ChatMsgData | ChatDateData;
