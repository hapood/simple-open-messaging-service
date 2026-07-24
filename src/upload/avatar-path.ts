import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/**
 * Avatar path/shape helpers — the single source of truth for the multi-size avatar pipeline's size
 * list and the URL/filename shapes it emits. Shared by:
 *  - {@link UploadService.saveAvatars} (writer) — imports AVATAR_SIZES/AVATAR_MAX,
 *  - the {@link IsValidAvatarPath} DTO validator (rejects /uploads/shards/ + external URLs for
 *    Group.avatar, so a group avatar can never sit under the per-object authz gate's shards/ scope),
 *  - the avatar GC (walks uploads/avatars/, groups files by <base>).
 *
 * URL shape: `/uploads/avatars/<base>-<size>.webp`. `<base>` = `${Date.now()}-${randomBytes(6).hex}`
 * (hyphenated); `<size>` ∈ AVATAR_SIZES.
 */

/** Avatar multi-size output widths (px). sharp re-encodes each; the largest is the representative URL.
 *  Single backend source — UploadService reads this, the regexes below embed it. Keep sorted asc. */
export const AVATAR_SIZES = [32, 64, 128, 256, 512] as const;

/** The representative (largest) size — the URL stored on User.avatar / Group.avatar. */
export const AVATAR_MAX = 512;

const SIZE_ALT = AVATAR_SIZES.join('|');

/** Matches an avatar FILENAME on disk: `<base>-<size>.webp`. Captures `<base>`. Used by the GC walk
 *  to identify avatar files and group all sizes of one logical avatar together. */
export const AVATAR_FILE_RE = new RegExp(
  `^([A-Za-z0-9._-]+)-(?:${SIZE_ALT})\\.webp$`,
);

/** Matches an avatar URL: `/uploads/avatars/<base>-<size>.webp`. Captures `<base>`. The literal
 *  `avatars/` segment + the absence of any other `/` after it means `/uploads/shards/aa/bb/<digest>.<ext>`
 *  NEVER matches (shards has extra path segments) — so a group avatar can never be pointed at gated
 *  chat media. External (`https://`) and `javascript:` URLs likewise fail. */
export const AVATAR_URL_RE = new RegExp(
  `^/uploads/avatars/([A-Za-z0-9._-]+)-(?:${SIZE_ALT})\\.webp$`,
);

/** Extract the avatar `<base>` from a URL or a bare filename, or null if it is not an avatar path.
 *  Tries the URL form first, then the bare-filename form (GC passes filenames, DTOs pass URLs). */
export function parseAvatarBase(path: string): string | null {
  const m = AVATAR_URL_RE.exec(path) ?? AVATAR_FILE_RE.exec(path);
  return m ? m[1] : null;
}

/** True iff `value` is a valid avatar URL OR the empty string (empty = clear the avatar). The empty
 *  allowance is what @IsValidAvatarPath builds on so a client can unset a group avatar. */
export function isAvatarUrlOrEmpty(value: unknown): boolean {
  return typeof value === 'string' && (value === '' || AVATAR_URL_RE.test(value));
}

/**
 * class-validator decorator: the field must be a server-produced avatar URL (or empty). Used on
 * Group.avatar (create + update) so the value can only ever be an /uploads/avatars/ path the avatar
 * pipeline emitted — never a /uploads/shards/ chat-media URL (which the per-object authz gate would
 * 401) nor an external URL (which the server does not control/cleanup).
 */
export function IsValidAvatarPath(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidAvatarPath',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isAvatarUrlOrEmpty(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an /uploads/avatars/ avatar path`;
        },
      },
    });
  };
}
