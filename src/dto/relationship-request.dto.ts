import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn, IsInt, IsOptional, Max, Min,
  registerDecorator,
} from 'class-validator';

/** Validate before BigInt conversion, including PostgreSQL's signed bigint bound. */
export function IsRequestId(allowZero = false): PropertyDecorator {
  return (target, propertyKey) => registerDecorator({
    name: 'isRequestId', target: target.constructor, propertyName: String(propertyKey),
    validator: {
      validate(value: unknown) {
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
        const id = BigInt(value);
        return id >= (allowZero ? 0n : 1n) && id <= 9223372036854775807n;
      },
      defaultMessage: () => 'request ID must be a canonical decimal bigint string',
    },
  });
}

export class RequestPageDto {
  @ApiPropertyOptional({ type: String, description: 'Exclusive request ID; omit for newest page' })
  @IsOptional()
  @IsRequestId()
  before?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  take?: number;
}

export class QueryRelationshipRequestsDto extends RequestPageDto {
  @ApiProperty({ enum: ['RECEIVED', 'SENT'] })
  @IsIn(['RECEIVED', 'SENT'])
  bucket!: 'RECEIVED' | 'SENT';
}

export class RequestDecisionDto {
  @ApiProperty({ type: String, example: '42', description: 'Exact request round ID' })
  @IsRequestId()
  requestId!: string;
}
