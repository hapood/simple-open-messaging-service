import { IsRequestSnapshot, RequestSnapshotDto } from './request-snapshot.dto.js';
import { ApiProperty } from '@nestjs/swagger';
import { RequestDecisionDto, IsRequestId } from './relationship-request.dto.js';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Author a relationship request for an identity already resolved into a namespace.
 * Federated domain discovery and namespace binding happen before this command. */
export class RequestRelationshipDto {
  @ApiProperty({
    example: 'alice',
    description: 'Target user or group account',
  })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({
    example: 7,
    description: 'Target identity namespace id.',
  })
  @IsInt()
  @Min(0)
  namespaceId!: number;

  @ApiProperty({
    required: false,
    example: 'Hi from the conference',
    description: 'Relationship request note (≤255 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  @ApiProperty({ type: RequestSnapshotDto })
  @IsRequestSnapshot()
  snapshot!: RequestSnapshotDto;
}

/** End an established P2P relationship by its thread; symmetric to group leave
 * and never a request-round decision. */
export class RevokeRelationshipDto {
  @ApiProperty({ example: 12, description: 'P2P thread id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId!: number;
}

export class AcceptRelationshipDto extends RequestDecisionDto {}

/** Acknowledges the incoming head observed with a successful received-list query. */
export class ReadRelationshipRequestsDto {
  @ApiProperty({ type: String, example: '42' })
  @IsRequestId(true)
  requestReadId!: string;
}
