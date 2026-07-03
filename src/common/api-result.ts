import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * Unified response envelope. Every HTTP endpoint returns this structure (see protocol-plan §5.1).
 * - code: 0 = success; non-zero = business error code, segmented by domain (see src/common/business-code.ts).
 *   Business failures always return HTTP 200 + business code; only unauthenticated (401) / not-found (404) /
 *   conflict (409) / server-error (500) retain their HTTP status.
 * - message: human-readable status.
 * - data: the business payload (on success).
 *
 * Note: this is a response type — it is NOT validated by ValidationPipe, so its fields are explicitly
 * annotated with @ApiProperty (defined once). All DTOs in the project carry hand-written @ApiProperty —
 * the nest-cli swagger plugin is intentionally disabled (its classValidationShim emits same-file DTO
 * self-references as require() that crash under native ESM, see the swagger-plugin-removed decision).
 */
export class ApiResult<T = unknown> {
  @ApiProperty({
    example: 0,
    description:
      '0 = success; non-zero = business error code, segmented by domain: 10xxx general (10000 validation / 10001 not-found / 10002 already-exists / 10003 unauthenticated / 10005 rate-limited), 20xxx friends & sessions, 30xxx messages, 40xxx groups. See BusinessCode.',
  })
  code: number;

  @ApiProperty({ example: 'successful', description: 'Human-readable status message' })
  message: string;

  /**
   * Stable, dotted i18n key for this message (e.g. 'friend.msg.sent'). Clients that support i18n
   * translate via this key and fall back to `message`. Set only where a response carries a user-facing
   * status that code alone cannot disambiguate (notably success outcomes sharing code 0, e.g. the
   * friend-request "sent / already friends / now friends" variants). Error responses are localized
   * client-side by their numeric `code` (see BusinessCode), so they do not need a messageKey.
   */
  @ApiProperty({
    required: false,
    example: 'friend.msg.sent',
    description:
      'Optional i18n key. When present, i18n clients translate this and fall back to `message`.',
  })
  messageKey?: string;

  data?: T;

  @ApiProperty({
    type: 'boolean',
    nullable: true,
    description:
      'Populated only by paginated endpoints (e.g. query-messages): whether an earlier page exists. Undefined for non-paginated endpoints.',
  })
  hasMore?: boolean;
}

/**
 * Marks an endpoint's success (200) response as ApiResult<data: Model>.
 * Composed with allOf: {$ref: ApiResult} supplies code/message, then properties.data is overridden to the
 * Model's $ref. The resulting response schema is { code, message, data: Model } (enough for Prism to mock
 * enveloped responses).
 *
 * applyDecorators explicitly declares the 200 response so its schema is the enveloped one.
 */
export function ApiResultResponse<T>(model: Type<T>, isArray = false) {
  const dataSchema = isArray
    ? { type: 'array', items: { $ref: getSchemaPath(model) } }
    : { $ref: getSchemaPath(model) };
  return applyDecorators(
    ApiExtraModels(ApiResult, model),
    ApiOkResponse({
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiResult) },
          { properties: { data: dataSchema } },
        ],
      },
    }),
  );
}
