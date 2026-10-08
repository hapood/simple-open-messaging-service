import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDataURI,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

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

  @ApiProperty({
    required: false,
    description: 'Untrusted pending-card display snapshot.',
  })
  @ValidateIf((value: RequestRelationshipDto) => value.namespaceId !== 0)
  @IsString()
  @IsNotEmpty()
  @MaxLength(31)
  displayName?: string;

  @ApiProperty({
    required: false,
    description: 'Untrusted pending-card avatar Base64 data URL.',
  })
  @IsOptional()
  @IsString()
  @IsDataURI()
  @MaxLength(1_500_000)
  avatar?: string;
}

/** Revoke a user relationship/request or a pending federated group-join request by account and identity namespace. */
export class RevokeRelationshipDto {
  @ApiProperty({ example: 'alice', description: 'Peer user or group account' })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({
    example: 7,
    description: 'Peer identity namespace id.',
  })
  @IsInt()
  @Min(0)
  namespaceId!: number;
}

/** Select a pending relationship request by counterparty account and identity namespace. */
export class AcceptRelationshipDto {
  @ApiProperty({ description: 'Peer user or group account' })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({
    example: 7,
    description: 'Peer identity namespace id.',
  })
  @IsInt()
  @Min(0)
  namespaceId!: number;
}

/** Advance the account-wide relationship-request read watermark. The value is a client state-feed
 * cursor that the caller has already applied durably; it is not a relationship intent id. */
export class ReadRelationshipRequestsDto {
  @ApiProperty({
    description:
      'Highest client state-feed id durably applied before relationship requests were viewed',
    example: 1234,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readThroughFeedId!: number;
}
