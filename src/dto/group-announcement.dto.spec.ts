import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import {
  SetGroupAnnouncementDto,
  ReadGroupAnnouncementDto,
} from './group.dto.js';

describe('Group announcement command DTOs', () => {
  async function errors(text: unknown) {
    const dto = new SetGroupAnnouncementDto();
    dto.groupId = 1;
    dto.text = text as string | null;
    return validate(dto);
  }

  it('accepts a clear and 4096 Unicode code points', async () => {
    expect(await errors(null)).toEqual([]);
    expect(await errors('🗣️'.repeat(2048))).toEqual([]);
  });

  it('rejects missing, empty, non-text and oversized announcements', async () => {
    for (const text of [undefined, '', 42, 'a'.repeat(4097)])
      expect(await errors(text)).not.toEqual([]);
  });

  it('requires a positive integer displayed announcement coordinate', async () => {
    const dto = new ReadGroupAnnouncementDto();
    dto.groupId = 1;
    for (const feedId of [0, -1, 1.5]) {
      dto.announcementFeedId = feedId;
      expect(await validate(dto)).not.toEqual([]);
    }
    dto.announcementFeedId = 1;
    expect(await validate(dto)).toEqual([]);
  });
});
