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

/** Send a friend invite (optionally with a ≤255-char note). The target is addressed by userId — a
 *  local user OR a federated stub id (minted by /user/resolve). Federated delivery is automatic.
 *  Group invites are NOT sent here — they are minted by group/create + group/invite. */
export class SendFriendInviteDto {
  @ApiProperty({
    example: 1,
    description: 'Target user id (local user OR federated stub id)',
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

/** Live invite state for the group-invite dialog (/invite/detail). The dialog renders:
 *  alreadyJoined → "joined"; status != PENDING → "invalid"; expiresAt < Date.now() → "expired"; else → Join. */
export class InviteDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['FRIEND', 'GROUP'] }) kind!: string;
  @ApiProperty({
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'REVOKED', 'EXPIRED'],
  })
  status!: string;
  @ApiProperty({ description: 'Expiry (ms epoch).' }) expiresAt!: number;
  @ApiProperty() note!: string;
  @ApiProperty({ required: false }) threadId?: number;
  @ApiProperty() groupName!: string;
  @ApiProperty() groupAvatar!: string;
  @ApiProperty({
    description: "The group's home domain (our domain for a local group).",
  })
  groupDomain!: string;
  @ApiProperty({
    description:
      'True iff the group is homed on THIS server (rendered as a "Local server" label; otherwise a globe + domain badge).',
  })
  groupIsLocal!: boolean;
  @ApiProperty({
    description: 'Is the caller already an active member of the target group?',
  })
  alreadyJoined!: boolean;
  @ApiProperty({
    description:
      'The caller accepted a federated invite and is waiting for the origin server to confirm membership.',
  })
  joinRequested!: boolean;
  @ApiProperty({ type: InviteUserDto }) fromUser!: InviteUserDto;
}
