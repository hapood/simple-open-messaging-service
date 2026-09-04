import {
  mergeAlbumItems,
  mergeAlbumItemsAtBoundary,
  absorbAlbumTail,
  ALBUM_MAX,
} from './merge-items';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { AlbumImage, ChatItemData } from './chat-item';

const creatorKey = (creator: number): string =>
  JSON.stringify([0, 'local', `user-${creator}`]);

/**
 * mergeAlbumItems unit tests: album-merge semantics + preservation of kernel correlation fields.
 *
 * Key regression: the merged output must NOT drop clientMessageId — it is the key that loadNewer → mountNewerReals
 * uses to pair a confirmed real with its optimistic bubble (matched by clientMessageId, not id). Rebuilding the output
 * as {id,ids,data,boundary} used to strip it, so an optimistic IMAGE send's real was treated as a fresh incoming
 * message and mounted beside the un-reconciled optimistic bubble → duplicate picture after the push signal.
 * (PURE_TEXT took the else branch and was pushed as-is, so text was never affected — only images duplicated.)
 */
describe('mergeAlbumItems', () => {
  it('caps albums at the six visible media cells so the layout never folds an album', () => {
    expect(ALBUM_MAX).toBe(6);
  });

  /** A single image (its msgId is the owning message's id). */
  const img = (msgId: number): AlbumImage => ({
    kind: 'image',
    src: `data:,${msgId}`,
    w: 100,
    h: 100,
    msgId,
  });

  /** A single-image IMAGE msg item (creator defaults to 1 = self). */
  const imageItem = (
    id: number,
    clientMessageId?: string,
    creator = 1,
  ): CbItem<ChatItemData> => ({
    id,
    clientMessageId,
    data: {
      type: 'msg',
      msgId: id,
      creator: creatorKey(creator),
      isSelf: creator === 1,
      name: 'Me',
      text: '',
      time: '00:00',
      contentType: 'IMAGE',
      images: [img(id)],
      file: null,
      createdAtMs: 0,
    },
  });

  it('regression: a lone IMAGE carrying clientMessageId PRESERVES it (optimistic→real reconcile key)', () => {
    // The confirmed real of an optimistic image send: a fresh server id (1000) + the SAME clientMessageId as the
    // optimistic bubble. After merge this clientMessageId must survive so mountNewerReals can match the confirm.
    const real = imageItem(1000, 'cid-0');
    const out = mergeAlbumItems([real]);
    expect(out.length).toBe(1);
    expect(out[0].clientMessageId).toBe('cid-0'); // pre-fix: undefined → confirm lost → duplicate picture
  });

  it('regression: a lone IMAGE preserves boundary too (newest marker drives the optimistic lifecycle)', () => {
    const real = { ...imageItem(1000, 'cid-0'), boundary: 'newest' as const };
    const out = mergeAlbumItems([real]);
    expect(out[0].boundary).toBe('newest');
    expect(out[0].clientMessageId).toBe('cid-0');
  });

  it('non-IMAGE (PURE_TEXT) passes through untouched (clientMessageId preserved) — text never duplicated', () => {
    const text: CbItem<ChatItemData> = {
      id: 2000,
      clientMessageId: 'cid-t',
      data: {
        type: 'msg',
        msgId: 2000,
        creator: creatorKey(1),
        isSelf: true,
        name: 'Me',
        text: 'hi',
        time: '00:00',
        contentType: 'PURE_TEXT',
        images: null,
        file: null,
        createdAtMs: 0,
      },
    };
    const out = mergeAlbumItems([text]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(text); // as-is (same reference)
  });

  it('merges consecutive same-creator IMAGE msgs into one album (images concatenated; ids = all members)', () => {
    const a = imageItem(0);
    const b = imageItem(1);
    const c = imageItem(2);
    const out = mergeAlbumItems([a, b, c]);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe(0); // head id
    expect(out[0].ids).toEqual([0, 1, 2]); // every member msgId (jump-to-image resolution)
    expect(out[0].data.images?.map((i) => i.msgId)).toEqual([0, 1, 2]); // concatenated
  });

  it('merges a same-batch self-sent burst (each IMAGE real carries a cid): unions ALL clientMessageIds', () => {
    // Two SSE echoes of self-sent images land in ONE getNewer batch. mergeAlbumItems merges them, and must union every
    // member's cid onto the album so reconcileOptimistic removes BOTH optimistic bubbles — without this, only the head's
    // cid survives and the tail member's optimistic orphans (the merged album fulfills it but the kernel can't see it).
    const a = imageItem(1010, 'cid-a');
    const b = imageItem(1020, 'cid-b');
    const out = mergeAlbumItems([a, b]);
    expect(out.length).toBe(1);
    expect(out[0].clientMessageId).toBe('cid-a'); // head's cid preserved (spread)
    expect(out[0].clientMessageIds).toEqual(['cid-a', 'cid-b']); // every member cid (reconcile key for all)
  });

  it('a pure incoming album (no cids) leaves clientMessageIds undefined (nothing to reconcile)', () => {
    const out = mergeAlbumItems([imageItem(0), imageItem(1)]);
    expect(out.length).toBe(1);
    expect(out[0].clientMessageIds).toBeUndefined(); // no optimistic sends → no cid list
  });

  it('a mixed run (some cids, some not) unions only the cids that are present', () => {
    const a = imageItem(1010, 'cid-a'); // self-sent (has cid)
    const b = imageItem(50); // incoming (no cid)
    const out = mergeAlbumItems([a, b]);
    expect(out.length).toBe(1);
    expect(out[0].clientMessageIds).toEqual(['cid-a']); // only the self-sent member's cid
  });

  it('does NOT merge across a creator change (album breaks on sender switch)', () => {
    const mine = imageItem(0, undefined, 1);
    const theirs = imageItem(1, undefined, 2);
    const out = mergeAlbumItems([mine, theirs]);
    expect(out.length).toBe(2);
  });

  it('does NOT merge across a non-IMAGE (album breaks on an interleaved text)', () => {
    const a = imageItem(0);
    const text: CbItem<ChatItemData> = {
      id: 2000,
      data: {
        type: 'msg',
        msgId: 2000,
        creator: creatorKey(1),
        isSelf: true,
        name: 'Me',
        text: 'x',
        time: '00:00',
        contentType: 'PURE_TEXT',
        images: null,
        file: null,
        createdAtMs: 0,
      },
    };
    const b = imageItem(1);
    const out = mergeAlbumItems([a, text, b]);
    expect(out.length).toBe(3);
  });

  it('a lone IMAGE that did not merge leaves ids undefined (id alone identifies it)', () => {
    const out = mergeAlbumItems([imageItem(0)]);
    expect(out[0].ids).toBeUndefined();
  });

  it('boundary inheritance: a non-head member carrying newest tags the merged album', () => {
    const a = imageItem(0);
    const b = { ...imageItem(1), boundary: 'newest' as const };
    const out = mergeAlbumItems([a, b]);
    expect(out[0].boundary).toBe('newest'); // inherited from a later member when the head lacks it
  });

  it('splits a same-creator run exceeding ALBUM_MAX into separate albums (cap-aware)', () => {
    const n = ALBUM_MAX + 3;
    const batch: CbItem<ChatItemData>[] = [];
    for (let i = 0; i < n; i++) batch.push(imageItem(i));
    const out = mergeAlbumItems(batch);
    expect(out.length).toBe(2); // ALBUM_MAX + 3
    expect(out[0].data.images!.length).toBe(ALBUM_MAX);
    expect(out[1].data.images!.length).toBe(3);
  });

  it('does not merge a same-sender media run across the unread divider host', () => {
    const out = mergeAlbumItemsAtBoundary(
      [imageItem(10), imageItem(11), imageItem(12)],
      11,
    );

    expect(out.length).toBe(2);
    expect(out[0].id).toBe(10);
    expect(out[1].id).toBe(11);
    expect(out[1].ids).toEqual([11, 12]);
  });
});

describe('absorbAlbumTail (cross-batch absorb hook)', () => {
  const oneImg = (msgId: number): AlbumImage => ({
    kind: 'image',
    src: `data:,${msgId}`,
    w: 100,
    h: 100,
    msgId,
  });
  /** An IMAGE msg carrying `n` images (default 1, mirroring the source's one-image-per-msg). */
  const imageItem = (id: number, n = 1, creator = 1): CbItem<ChatItemData> => ({
    id,
    data: {
      type: 'msg',
      msgId: id,
      creator: creatorKey(creator),
      isSelf: creator === 1,
      name: 'Me',
      text: '',
      time: '00:00',
      contentType: 'IMAGE',
      images: Array.from({ length: n }, () => oneImg(id)),
      file: null,
      createdAtMs: 0,
    },
  });
  const textItem = (id: number, creator = 1): CbItem<ChatItemData> => ({
    id,
    data: {
      type: 'msg',
      msgId: id,
      creator: creatorKey(creator),
      isSelf: creator === 1,
      name: 'Me',
      text: 'hi',
      time: '00:00',
      contentType: 'PURE_TEXT',
      images: null,
      file: null,
      createdAtMs: 0,
    },
  });

  it('merges same-creator images: concatenates images + unions member ids, keeps the head id', () => {
    const merged = absorbAlbumTail(imageItem(1), imageItem(2));
    expect(merged).not.toBeNull();
    expect(merged!.id).toBe(1); // head id preserved
    expect(merged!.data.images!.map((i) => i.msgId)).toEqual([1, 2]); // concatenated
    expect(merged!.ids).toEqual([1, 2]); // unioned for jump resolution
  });

  it('absorbs a self-sent real (confirm): unions clientMessageIds onto the album (head + incoming)', () => {
    // The cross-signal case: each self-sent image's real arrives in its own SSE frame and absorbs into the running
    // album. The absorbed real's cid must land on the merged album so reconcileOptimistic removes its optimistic bubble.
    const target: CbItem<ChatItemData> = {
      ...imageItem(1010),
      clientMessageId: 'cid-a',
    };
    const incoming: CbItem<ChatItemData> = {
      ...imageItem(1020),
      clientMessageId: 'cid-b',
    };
    const merged = absorbAlbumTail(target, incoming);
    expect(merged).not.toBeNull();
    expect(merged!.clientMessageId).toBe('cid-a'); // head cid preserved (spread target)
    expect(merged!.clientMessageIds).toEqual(['cid-a', 'cid-b']); // incoming cid carried onto the album
  });

  it('absorbs a self-sent real into an album that already holds member cids: unions the full set', () => {
    // An album that has already absorbed one self-sent image (clientMessageIds=['cid-a','cid-b']) absorbs a third:
    // the result carries the union of every member's cid, not just the new one.
    const target: CbItem<ChatItemData> = {
      ...imageItem(1010),
      clientMessageId: 'cid-a',
      clientMessageIds: ['cid-a', 'cid-b'],
    };
    const incoming: CbItem<ChatItemData> = {
      ...imageItem(1030),
      clientMessageId: 'cid-c',
    };
    const merged = absorbAlbumTail(target, incoming);
    expect(merged).not.toBeNull();
    expect(merged!.clientMessageIds).toEqual(['cid-a', 'cid-b', 'cid-c']); // full union
  });

  it('a pure incoming absorb (no cids on either side) leaves clientMessageIds undefined', () => {
    const merged = absorbAlbumTail(imageItem(1), imageItem(2));
    expect(merged).not.toBeNull();
    expect(merged!.clientMessageIds).toBeUndefined(); // no optimistic → no cid list
  });

  it('returns null when creators differ', () => {
    expect(absorbAlbumTail(imageItem(1, 1, 1), imageItem(2, 1, 2))).toBeNull();
  });

  it('returns null when target or incoming is not an image', () => {
    expect(absorbAlbumTail(textItem(1), imageItem(2))).toBeNull();
    expect(absorbAlbumTail(imageItem(1), textItem(2))).toBeNull();
  });

  it('returns null over ALBUM_MAX (all-or-nothing; the incoming item starts a new album instead)', () => {
    expect(absorbAlbumTail(imageItem(1, ALBUM_MAX), imageItem(2))).toBeNull(); // target already at cap
    expect(
      absorbAlbumTail(imageItem(1, ALBUM_MAX - 1), imageItem(2, 2)),
    ).toBeNull(); // (cap-1) + 2 > cap
  });

  it('absorbs exactly up to the cap: (cap - 1) + 1 = cap', () => {
    const merged = absorbAlbumTail(imageItem(1, ALBUM_MAX - 1), imageItem(2));
    expect(merged).not.toBeNull();
    expect(merged!.data.images!.length).toBe(ALBUM_MAX);
  });
});
