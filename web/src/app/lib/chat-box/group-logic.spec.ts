import { classifyGroupFlags, GroupCtx } from './group-logic';

describe('classifyGroupFlags', () => {
  // Factory: senders 1 / 2 (WhatsApp-style consecutive grouping by sender, no time window).
  const A: GroupCtx = { creator: 1 };
  const B: GroupCtx = { creator: 2 };

  it('no prev (list first item / after a date separator) → group head isShowHead=true', () => {
    expect(classifyGroupFlags(null, A, A)).toEqual({
      isShowHead: true,
      isDateShrink: true,
    });
  });

  it('sender change → isShowHead=true (starts a new group)', () => {
    expect(classifyGroupFlags(A, B, B).isShowHead).toBe(true);
  });

  it('same sender consecutive → isShowHead=false, isDateShrink=true (in-group)', () => {
    const r = classifyGroupFlags(A, A, A);
    expect(r.isShowHead).toBe(false);
    expect(r.isDateShrink).toBe(true);
  });

  it('last item (next=null) → isDateShrink=false', () => {
    expect(classifyGroupFlags(A, A, null).isDateShrink).toBe(false);
  });

  it('next changes sender → isDateShrink=false (next starts a new group)', () => {
    expect(classifyGroupFlags(A, A, B).isDateShrink).toBe(false);
  });

  it('sole item (no prev, no next) → group head, not in-group', () => {
    expect(classifyGroupFlags(null, A, null)).toEqual({
      isShowHead: true,
      isDateShrink: false,
    });
  });
});
