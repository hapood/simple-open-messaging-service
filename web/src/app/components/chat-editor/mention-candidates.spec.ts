import { mentionSearchPlan } from './mention-candidates';

describe('mentionSearchPlan', () => {
  it('reserves the first slot for a matching audience label', () => {
    expect(mentionSearchPlan('EVER', 'Everyone', true)).toEqual({
      includeAll: true,
      memberLimit: 4,
    });
    expect(mentionSearchPlan('有人', '所有人', true).memberLimit).toBe(4);
  });

  it('includes the audience row for an empty query', () => {
    expect(mentionSearchPlan('  ', 'Everyone', true)).toEqual({
      includeAll: true,
      memberLimit: 4,
    });
  });

  it('uses all five member slots when the audience does not match or is forbidden', () => {
    expect(mentionSearchPlan('alice', 'Everyone', true)).toEqual({
      includeAll: false,
      memberLimit: 5,
    });
    expect(mentionSearchPlan('', 'Everyone', false)).toEqual({
      includeAll: false,
      memberLimit: 5,
    });
  });
});
