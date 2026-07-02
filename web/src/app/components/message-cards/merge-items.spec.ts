import { mergeAlbumItems } from './merge-items';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { AlbumImage, ChatItemData } from './chat-item';

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
  /** A single image (its msgId is the owning message's id). */
  const img = (msgId: string): AlbumImage => ({ src: `data:,${msgId}`, w: 100, h: 100, msgId });

  /** A single-image IMAGE msg item (creator defaults to 1 = self). */
  const imageItem = (id: string, clientMessageId?: string, creator = 1): CbItem<ChatItemData> => ({
    id,
    clientMessageId,
    data: {
      type: 'msg', msgId: id, creator, isSelf: creator === 1, name: 'Me', text: '',
      time: '00:00', contentType: 'IMAGE', images: [img(id)], file: null, createdAtMs: 0,
    },
  });

  it('regression: a lone IMAGE carrying clientMessageId PRESERVES it (optimistic→real reconcile key)', () => {
    // The confirmed real of an optimistic image send: a fresh server id ('real-0') + the SAME clientMessageId as the
    // optimistic bubble. After merge this clientMessageId must survive so mountNewerReals can match the confirm.
    const real = imageItem('real-0', 'cid-0');
    const out = mergeAlbumItems([real]);
    expect(out.length).toBe(1);
    expect(out[0].clientMessageId).toBe('cid-0'); // pre-fix: undefined → confirm lost → duplicate picture
  });

  it('regression: a lone IMAGE preserves boundary too (newest marker drives the optimistic lifecycle)', () => {
    const real = { ...imageItem('real-0', 'cid-0'), boundary: 'newest' as const };
    const out = mergeAlbumItems([real]);
    expect(out[0].boundary).toBe('newest');
    expect(out[0].clientMessageId).toBe('cid-0');
  });

  it('non-IMAGE (PURE_TEXT) passes through untouched (clientMessageId preserved) — text never duplicated', () => {
    const text: CbItem<ChatItemData> = {
      id: 't-0', clientMessageId: 'cid-t',
      data: { type: 'msg', msgId: 't-0', creator: 1, isSelf: true, name: 'Me', text: 'hi', time: '00:00', contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 0 },
    };
    const out = mergeAlbumItems([text]);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(text); // as-is (same reference)
  });

  it('merges consecutive same-creator IMAGE msgs into one album (images concatenated; ids = all members)', () => {
    const a = imageItem('m-0');
    const b = imageItem('m-1');
    const c = imageItem('m-2');
    const out = mergeAlbumItems([a, b, c]);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('m-0'); // head id
    expect(out[0].ids).toEqual(['m-0', 'm-1', 'm-2']); // every member msgId (jump-to-image resolution)
    expect(out[0].data.images?.map(i => i.msgId)).toEqual(['m-0', 'm-1', 'm-2']); // concatenated
  });

  it('does NOT merge across a creator change (album breaks on sender switch)', () => {
    const mine = imageItem('m-0', undefined, 1);
    const theirs = imageItem('m-1', undefined, 2);
    const out = mergeAlbumItems([mine, theirs]);
    expect(out.length).toBe(2);
  });

  it('does NOT merge across a non-IMAGE (album breaks on an interleaved text)', () => {
    const a = imageItem('m-0');
    const text: CbItem<ChatItemData> = {
      id: 't-0', data: { type: 'msg', msgId: 't-0', creator: 1, isSelf: true, name: 'Me', text: 'x', time: '00:00', contentType: 'PURE_TEXT', images: null, file: null, createdAtMs: 0 },
    };
    const b = imageItem('m-1');
    const out = mergeAlbumItems([a, text, b]);
    expect(out.length).toBe(3);
  });

  it('a lone IMAGE that did not merge leaves ids undefined (id alone identifies it)', () => {
    const out = mergeAlbumItems([imageItem('m-0')]);
    expect(out[0].ids).toBeUndefined();
  });

  it('boundary inheritance: a non-head member carrying newest tags the merged album', () => {
    const a = imageItem('m-0');
    const b = { ...imageItem('m-1'), boundary: 'newest' as const };
    const out = mergeAlbumItems([a, b]);
    expect(out[0].boundary).toBe('newest'); // inherited from a later member when the head lacks it
  });
});
