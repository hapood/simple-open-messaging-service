/**
 * 相册合并（mergeItems hook 实现）：把一个 source batch 内【连续同 creator 的 IMAGE msg】合并成
 * 一个相册 item。从 HttpItemSource.toItems 抽出的纯合并逻辑（去重留 source IO 层，本函数只做展示合并）。
 *
 * 【镜像生产语义】生产 rawToItems 给「每条 IMAGE msg 单图」原始 item；本函数把 batch 内连续同
 *  creator 的多条合成一个多图相册 item（images 拼接）——与生产 toItems 的合并同构，但现在在内核
 *  mergeItems hook 里（per-batch，createItem 前），source 不掺展示。
 *
 * - 合并产物 id = 首 msg 的 msgId（相册代表 id）；images 拼接各图（各带原 msgId，供 dev 角标显范围）。
 * - boundary 继承：合并范围内任一带 boundary → 合并产物带（首条优先，续条仅在首条无时补）。
 * - scope = 一个 source batch（per-batch，跨 batch 切断 —— 与生产 PAGE_TAKE 不跨页等价）。
 */
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from './chat-item';

export function mergeAlbumItems(items: CbItem<ChatItemData>[]): CbItem<ChatItemData>[] {
  const out: CbItem<ChatItemData>[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const msg = it.data;
    if (msg.contentType === 'IMAGE' && msg.images) {
      const imgs = [...msg.images];
      let boundary = it.boundary; // 首条 boundary 优先
      let j = i + 1;
      while (j < items.length) {
        const nj = items[j].data;
        if (nj.contentType !== 'IMAGE' || nj.creator !== msg.creator) break; // 断：非 IMAGE 或换发送者
        imgs.push(...(nj.images ?? []));
        if (!boundary && items[j].boundary) boundary = items[j].boundary; // 续条 boundary 仅在首条无时补
        j++;
      }
      // Record every member msgId on the merged album so the kernel can resolve a jump to any image
      // (not just the head). ids includes the head (imgs[0].msgId === msg.msgId). A lone IMAGE msg that
      // didn't actually merge (imgs.length === 1) leaves ids undefined — id alone identifies it.
      const memberIds = imgs
        .map(im => im.msgId)
        .filter((x: string | undefined): x is string => typeof x === 'string' && x.length > 0);
      out.push({ id: msg.msgId, ids: memberIds.length > 1 ? memberIds : undefined, data: { ...msg, images: imgs }, boundary });
      i = j;
    } else {
      out.push(it);
      i++;
    }
  }
  return out;
}
