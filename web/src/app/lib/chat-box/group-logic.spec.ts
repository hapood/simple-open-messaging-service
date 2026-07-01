import { classifyGroupFlags, GroupCtx } from './group-logic';

describe('classifyGroupFlags', () => {
  // 工厂：发送者 1 / 2（WhatsApp 式按发送者连续分组，不再用时间窗口）。
  const A: GroupCtx = { creator: 1 };
  const B: GroupCtx = { creator: 2 };

  it('无 prev（列表首条 / 日期分隔后）→ 组首 isShowHead=true', () => {
    expect(classifyGroupFlags(null, A, A)).toEqual({ isShowHead: true, isDateShrink: true });
  });

  it('换发送者 → isShowHead=true（开新组）', () => {
    expect(classifyGroupFlags(A, B, B).isShowHead).toBe(true);
  });

  it('同发送者连续 → isShowHead=false, isDateShrink=true（组内）', () => {
    const r = classifyGroupFlags(A, A, A);
    expect(r.isShowHead).toBe(false);
    expect(r.isDateShrink).toBe(true);
  });

  it('末条（next=null）→ isDateShrink=false', () => {
    expect(classifyGroupFlags(A, A, null).isDateShrink).toBe(false);
  });

  it('next 换发送者 → isDateShrink=false（下条开新组）', () => {
    expect(classifyGroupFlags(A, A, B).isDateShrink).toBe(false);
  });

  it('唯一一条（无 prev 无 next）→ 组首、非组内', () => {
    expect(classifyGroupFlags(null, A, null)).toEqual({ isShowHead: true, isDateShrink: false });
  });
});
