import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

/** Max length for a display name (kept aligned with the historical UpdateProfileDto cap). */
export const DISPLAY_NAME_MAX = 30;

/**
 * C0 (U+0000-U+001F) + C1 (U+007F-U+009F) control characters. Built from a string via new RegExp so
 * the source file holds readable escape sequences instead of invisible control bytes. Covers newlines,
 * tabs, DEL, bidi overrides, and other zero-width/layout-abusing control points.
 */
const CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

/**
 * Strip control chars (see above) and trim surrounding whitespace. Every other visible code point is
 * preserved: CJK, emoji, spaces, punctuation. Control chars are STRIPPED rather than rejected so a
 * paste carrying a trailing newline is still accepted (lenient UX); the only hard rules — non-empty +
 * length cap — are enforced by @Length in IsDisplayName().
 */
function normalizeDisplayName(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(CONTROL_CHARS_RE, '').trim();
}

/**
 * Shared display-name validation used by both RegisterDto (required) and UpdateProfileDto (optional,
 * applied alongside @IsOptional()). Normalizes (strip control chars + trim), then enforces a non-empty
 * string of at most DISPLAY_NAME_MAX chars. Unicode-friendly — no charset restriction.
 */
export function IsDisplayName(): MethodDecorator & PropertyDecorator {
  return applyDecorators(
    Transform(({ value }) => normalizeDisplayName(value)),
    IsString(),
    Length(1, DISPLAY_NAME_MAX, {
      message: `name must be 1-${DISPLAY_NAME_MAX} chars`,
    }),
  );
}
