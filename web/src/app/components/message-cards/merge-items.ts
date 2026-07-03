/**
 * Album aggregation — the two kernel hooks for collapsing same-creator IMAGE messages into album items:
 *
 *  1. mergeAlbumItems — within ONE source batch, merge [consecutive same-creator IMAGE msgs] into a single album item
 *     (per-batch, before createItem).
 *  2. absorbAlbumTail — CROSS-batch "image-burst absorb": when a newer batch's same-creator IMAGE would land right after
 *     the current newest album, fold it into that album in place (kernel morphs, no new bubble). This covers the case
 *     per-batch merging cannot — a burst split across batches/signals.
 *
 * Both share ALBUM_MAX: one album holds at most N images; overflow starts a fresh album (all-or-nothing — a single
 * incoming item is never split). The source always keeps every individual IMAGE msg; an album is presentation only, so
 * an absorbed image is never lost (jumps still resolve by member msgId).
 *
 * - Merged item id = the head msg's msgId (the album's representative id); images concatenates each image (each keeps its
 *   own msgId, for the dev badge range + the future viewer's positioning).
 * - boundary inheritance: any member carrying a boundary => the merged item carries it (head wins; a later member's
 *   boundary only fills in when the head has none).
 * - scope of mergeAlbumItems = one source batch (per-batch, cut across batches — mirrors production PAGE_TAKE not
 *   crossing a page); cross-batch is absorbAlbumTail's job.
 */
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from './chat-item';

/** Max images a single album item will hold. Shared by mergeAlbumItems (per-batch) and absorbAlbumTail (cross-batch) so a
 *  burst splits consistently regardless of how it arrives. Presentation-only — the source keeps every individual IMAGE msg. */
export const ALBUM_MAX = 10;

/** Collect the member msgIds of an album's images (for kernel jump resolution + the dev badge / viewer). Undefined when
 *  the album has fewer than 2 (a lone image is identified by its own id). Shared by both merge paths so the ids contract
 *  is identical. */
function albumMemberIds(images: { msgId?: string }[]): string[] | undefined {
  const ids = images
    .map(im => im.msgId)
    .filter((x: string | undefined): x is string => typeof x === 'string' && x.length > 0);
  return ids.length > 1 ? ids : undefined;
}

export function mergeAlbumItems(items: CbItem<ChatItemData>[]): CbItem<ChatItemData>[] {
  const out: CbItem<ChatItemData>[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const msg = it.data;
    if (msg.contentType === 'IMAGE' && msg.images) {
      const imgs = [...msg.images];
      let boundary = it.boundary; // head's boundary wins
      let j = i + 1;
      while (j < items.length) {
        const nj = items[j].data;
        if (nj.contentType !== 'IMAGE' || nj.creator !== msg.creator) break; // break: not IMAGE, or sender changed
        const nextImgs = nj.images ?? [];
        if (imgs.length + nextImgs.length > ALBUM_MAX) break; // cap: absorbing would exceed it -> remaining same-creator
        // images start a fresh album (the outer loop resumes from j).
        imgs.push(...nextImgs);
        if (!boundary && items[j].boundary) boundary = items[j].boundary; // a later boundary only fills in when head has none
        j++;
      }
      // Spread the head item so kernel correlation fields survive the merge — most importantly clientMessageId, which
      // pairs a confirmed real with its optimistic bubble (loadNewer -> mountNewerReals matches the confirm by
      // clientMessageId, not id). Rebuilding from only {id,ids,data,boundary} silently stripped it, so an optimistic
      // IMAGE send's real was treated as a fresh incoming message and mounted beside the un-reconciled optimistic
      // bubble -> duplicate picture after the push signal (PURE_TEXT was unaffected: it takes the else branch, pushed
      // as-is). it.id === msg.msgId holds throughout the source, so the explicit id is dropped as redundant.
      out.push({ ...it, ids: albumMemberIds(imgs), data: { ...msg, images: imgs }, boundary });
      i = j;
    } else {
      out.push(it);
      i++;
    }
  }
  return out;
}

/**
 * Cross-batch image-burst absorb (the kernel's absorbTail hook). When `incoming` from a newer batch is about to mount
 * right after the current newest album `target`: if both are IMAGE, same creator, and the merged album stays within
 * ALBUM_MAX, return the merged item (target's data + concatenated images + unioned ids) so the kernel can morph `target`
 * in place (no new bubble). Otherwise return null and the kernel mounts `incoming` normally (over cap => incoming
 * becomes the head of a new album).
 *
 * All-or-nothing: the whole `incoming` is folded (never split); over cap => no absorb. Only `incoming` is judged here;
 * the IMAGE/creator checks live in this function (the domain layer), keeping the kernel domain-agnostic.
 */
export function absorbAlbumTail(target: CbItem<ChatItemData>, incoming: CbItem<ChatItemData>): CbItem<ChatItemData> | null {
  const t = target.data, ic = incoming.data;
  if (t.contentType !== 'IMAGE' || ic.contentType !== 'IMAGE') return null; // only images absorb
  if (t.creator !== ic.creator) return null;                               // same sender only
  const tImgs = t.images ?? [], icImgs = ic.images ?? [];
  if (tImgs.length + icImgs.length > ALBUM_MAX) return null;                // cap (all-or-nothing -> new album)
  // Spread target so id / clientMessageId / boundary survive (same rationale as mergeAlbumItems).
  return { ...target, data: { ...t, images: [...tImgs, ...icImgs] }, ids: albumMemberIds([...tImgs, ...icImgs]) };
}
