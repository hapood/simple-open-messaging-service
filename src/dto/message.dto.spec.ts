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

describe('QueryMessagesDto truncation', () => {
  it('accepts a non-negative truncateSeq with the trigger flag', async () => {
    const value = Object.assign(new QueryMessagesDto(), {
      threadId: 1,
      skip: 1,
      take: 20,
      lastSeq: 10,
      orderBy: 'asc',
      truncate: true,
      truncateSeq: 30,
    });
    expect(await validate(value)).toHaveLength(0);
  });

  it('rejects a negative truncateSeq', async () => {
    const value = Object.assign(new QueryMessagesDto(), {
      threadId: 1,
      skip: 1,
      take: 20,
      orderBy: 'desc',
      truncate: true,
      truncateSeq: -1,
    });
    expect(await validate(value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'truncateSeq' }),
      ]),
    );
  });
});
