import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { QueryMessagesDto, SendMessageDto } from './message.dto.js';

function dto(contentType: string): SendMessageDto {
  return Object.assign(new SendMessageDto(), {
    threadId: 1,
    content: '{"text":"hello"}',
    contentType,
  });
}

describe('SendMessageDto', () => {
  it.each(['PURE_TEXT', 'LINK'])('allows direct-send type %s', async (type) => {
    expect(await validate(dto(type))).toHaveLength(0);
  });

  it.each(['IMAGE', 'FILE', 'VIDEO', 'AUDIO'])(
    'rejects media type %s because media must use the staged upload flow',
    async (type) => {
      expect(await validate(dto(type))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'contentType' }),
        ]),
      );
    },
  );
});

describe('QueryMessagesDto cursors', () => {
  it('accepts canonical decimal range cursors', async () => {
    const value = Object.assign(new QueryMessagesDto(), {
      threadId: 1,
      take: 20,
      after: '10',
      through: '30',
    });
    expect(await validate(value)).toHaveLength(0);
  });

  it('rejects a negative cursor', async () => {
    const value = Object.assign(new QueryMessagesDto(), {
      threadId: 1,
      take: 20,
      before: '-1',
    });
    expect(await validate(value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'before' })]),
    );
  });
});
