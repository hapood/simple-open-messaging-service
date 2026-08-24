import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class FriendRelationshipStatusDto {
  @ApiProperty({
    type: Number,
    isArray: true,
    example: [2, 3],
    description: 'Target user ids (≤50)',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsInt({ each: true })
  userIds!: number[];
}

export class FriendRelationshipStateDto {
  @ApiProperty() userId!: number;
  @ApiProperty({
    enum: ['NONE', 'OUTGOING_PENDING', 'INCOMING_PENDING', 'FRIEND'],
  })
  status!: 'NONE' | 'OUTGOING_PENDING' | 'INCOMING_PENDING' | 'FRIEND';
  @ApiProperty({
    required: false,
    description: 'Pending invite id, when applicable',
  })
  inviteId?: string;
}

/** Send a friend invite (optionally with a ≤255-char note) to a local user or an existing
 * federated stub. A foreign Address without a stub uses SendFederatedFriendInviteDto instead. */
export class SendFriendInviteDto {
  @ApiProperty({
    example: 1,
    description: 'Target local user id or existing federated stub id',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId!: number;

  @ApiProperty({
    required: false,
    example: 'Hi from the conference',
    description: 'Invite note (≤255 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** Send a federated friend request before a foreign User stub exists. Address is the routing identity;
 * displayName/avatar/bio are an untrusted card snapshot and never establish identity or relationship. */
export class SendFederatedFriendInviteDto {
  @ApiProperty({
    example: 'alice',
    description:
      'Federated target account. Used with domain instead of toUserId.',
  })
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({
    example: 'peer.example',
    description:
      'Federated target home domain. Used with account instead of toUserId.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain!: string;

  @ApiProperty({
    required: false,
    description: 'Untrusted pending-card display snapshot.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  displayName?: string;

  @ApiProperty({
    required: false,
    description: 'Untrusted pending-card avatar URL/data URL.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1_500_000)
  avatar?: string;

  @ApiProperty({
    description: 'Untrusted pending-card biography snapshot.',
  })
  @IsString()
  @MaxLength(255)
  bio!: string;

  @ApiProperty({
    required: false,
    example: 'Hi from the conference',
    description: 'Invite note (≤255 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;
}

/** Identify an invite by its id. The id is a BigInt carried as a string on the wire (JSON has no
 *  BigInt). Used by accept / reject / revoke. */
export class InviteIdDto {
  @ApiProperty({
    example: '123456789',
    description: 'Invite id (stringified BigInt)',
  })
  @IsString()
  @IsNotEmpty()
  inviteId!: string;
}

/** Advance the account-wide incoming-invitation read watermark. The value is a client state-feed
 * cursor that the caller has already applied durably; it is not an invitation business id. */
export class ReadIncomingInvitesDto {
  @ApiProperty({
    example: 1234,
    description:
      'Highest client state-feed id durably applied before the incoming invitation list was viewed',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  readThroughFeedId!: number;
}

/** Select a pending friend request. Local requests use their database id; pre-materialization
 * federated requests use the remote Address and never expose a second-table id namespace. */
export class FriendInviteActionDto {
  @ApiProperty({ required: false, description: 'Local invite id' })
  @ValidateIf((value: FriendInviteActionDto) => !value.account)
  @IsString()
  @IsNotEmpty()
  inviteId?: string;

  @ApiProperty({ required: false, description: 'Federated peer account' })
  @ValidateIf((value: FriendInviteActionDto) => !value.inviteId)
  @IsString()
  @IsNotEmpty()
  account?: string;

  @ApiProperty({ required: false, description: 'Federated peer domain' })
  @ValidateIf((value: FriendInviteActionDto) => !value.inviteId)
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain?: string;
}

/** Minimal user view embedded on an invite row (the inviter / the recipient). */
export class InviteUserDto {
  @ApiProperty() id!: number;
  @ApiProperty() account!: string;
  @ApiProperty() name!: string;
  @ApiProperty() avatar!: string;
  @ApiProperty() domain!: string;
  @ApiProperty() isForeigner!: boolean;
}

/** An invite as returned by /invite/incoming and /invite/outgoing. `expiresAt` (ms) lets the client
 *  render an "expired" prompt when it has passed (the row stays PENDING until a future GC sweep). */
export class InviteDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['FRIEND', 'GROUP'] }) kind!: string;
  @ApiProperty({ type: InviteUserDto }) fromUser!: InviteUserDto;
  @ApiProperty({ type: InviteUserDto }) toUser!: InviteUserDto;
  @ApiProperty({ required: false }) threadId?: number;
  @ApiProperty() note!: string;
  @ApiProperty({
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED'],
  })
  status!: string;
  @ApiProperty({
    description: 'Expiry (ms epoch). expiresAt < Date.now() → expired.',
  })
  expiresAt!: number;
  @ApiProperty() createdAt!: number;
}
