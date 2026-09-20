import { filterMentionCandidates } from './mention-candidates';

describe('filterMentionCandidates', () => {
  const members = [
    { id: 'zhangsan@example.com', label: '张三' },
    { id: 'zhangwei@example.com', label: '张伟' },
    { id: 'xiaozhang@example.com', label: '小张' },
    { id: 'alice@example.com', label: 'Alice' },
  ];

  it('returns every display name with the typed prefix', () => {
    expect(filterMentionCandidates(members, '张')).toEqual([
      members[0],
      members[1],
    ]);
  });

  it('also matches canonical-account prefixes case-insensitively', () => {
    expect(filterMentionCandidates(members, 'AL')).toEqual([members[3]]);
  });

  it('matches the full account@domain identity used by mention entities', () => {
    const member = { id: 'bobmu8azkcm@local', label: 'Bob' };
    expect(filterMentionCandidates([member], 'bobmu8')).toEqual([member]);
  });

  it('does not impose the old eight-result cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `zhang${i}@example.com`,
      label: `张${i}`,
    }));
    expect(filterMentionCandidates(many, '张')).toHaveLength(12);
  });
});
