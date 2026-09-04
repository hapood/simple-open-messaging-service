import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/** A validated avatar is stored once, with an extension derived from its actual bytes. */
export const AVATAR_URL_RE =
  /^\/uploads\/avatars\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpg|gif|webp)$/;

/** True iff `value` is a server avatar URL or the empty-string clear sentinel. */
export function isAvatarUrlOrEmpty(value: unknown): boolean {
  return (
    typeof value === 'string' && (value === '' || AVATAR_URL_RE.test(value))
  );
}

/** Require a server-produced avatar path, excluding CAS, external, and traversal URLs. */
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
