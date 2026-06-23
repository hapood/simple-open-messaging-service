import { applyDecorators, Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * 统一响应信封。所有 HTTP 接口返回此结构（见 protocol-plan §5.1）。
 * - code: 0 表示成功，非 0 为业务错误码（值沿用各 controller 现有实现；P1b 起按 §5.2 错误码段规整）。
 * - message: 人类可读提示。
 * - data: 业务数据（成功时）。
 *
 * 注意：这是响应类型，不经 ValidationPipe 校验，故字段用 @ApiProperty 显式标注（定义一次），
 * 不走 nest-cli swagger 插件 shim（shim 只服务于带 class-validator 的请求 DTO）。
 */
export class ApiResult<T = unknown> {
  @ApiProperty({ example: 0, description: '0 = 成功；非 0 = 业务错误码' })
  code: number;

  @ApiProperty({ example: 'successful', description: '人类可读的提示信息' })
  message: string;

  data?: T;
}

/**
 * 标注某端点「成功(200)」响应为 ApiResult<data: Model>。
 * 用 allOf 组合：{$ref: ApiResult} 提供 code/message，再用 properties.data 覆盖为 Model 的 $ref。
 * 这样响应 schema 是 { code, message, data: Model }（Prism 可据此 mock 出带信封的响应）。
 *
 * 用 applyDecorators 显式给出 200 响应，避免与 nest-cli swagger 插件按返回类型推断的 200 重复。
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
