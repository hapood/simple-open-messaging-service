import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MessageThreadType } from '../prisma/generated/client.js';
import { IsDisplayName } from '../common/validators.js';

/**
 * User-domain request DTOs. Validation rules are ported from the original inline checks.
 * Note: IsNumber + Type(() => Number) with the global ValidationPipe transform converts JSON/string input
 * to number (Prisma needs numeric ids).
 */

export class UserIdDto {
  @ApiProperty({ example: 1, description: 'User id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;
}

/** Body for /user/sync-peer-profile (chat-open + profile-panel-open staleness probe). `sinceProfileRev`
 *  is the caller's last-seen peer profileRev: when set and older than the live row, the server pushes a
 *  PEER_PROFILE_UPDATED signal so the client pulls the fresh profile. Response is always ACK-only. */
export class SyncPeerProfileDto extends UserIdDto {
  @ApiProperty({
    required: false,
    example: 3,
    description:
      "Caller's last-seen peer profileRev. When older than the live row, the server pushes a signal (client pulls).",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sinceProfileRev?: number;
}

/** Block or unblock a user (P2P). Independent of the friendship state machine — blocking survives an
 *  unfriend and applies to strangers. The message path drops fan-out to the blocker and filters
 *  query-messages so the blocker never sees the blocked user's messages. */
export class BlockDto {
  @ApiProperty({ example: 1, description: 'User id to block / unblock' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  @ApiProperty({ example: true, description: 'true = block, false = unblock' })
  @IsBoolean()
  block: boolean;
}

export class ThreadIdDto {
  @ApiProperty({ example: 12, description: 'Conversation (MessageThread) id' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  threadId: number;
}

/** Resolve a user to address in friend ops. `account` alone = local lookup; `account` + `domain` =
 *  federated (runs the init handshake + signed profile GET + stub localization). The `@` separator is a
 *  UI input aid ONLY — the client splits a typed `alice@bbb.com` into these two fields; the API never
 *  carries an @-joined string. */
export class UserResolveDto {
  @ApiProperty({ example: 'alice', description: "Account (a local account, or the peer user's account)" })
  @IsString()
  @IsNotEmpty()
  account: string;

  @ApiProperty({ required: false, example: 'bbb.com', description: 'Peer domain. Omitted/empty = local lookup.' })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  domain?: string;
}

/** Local user discovery (fuzzy). Matches account OR display name case-insensitively; min 2 chars so a
 *  single keystroke can't enumerate the user base. take is clamped server-side (see POST /user/search).
 *  Federated users are NOT discoverable here — resolve those by exact account + domain via UserResolveDto. */
export class UserSearchDto {
  @ApiProperty({ example: 'ali', description: 'Search query (≥2 chars; matches account OR display name)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(2, { message: 'q must be at least 2 chars' })
  q: string;

  @ApiProperty({ required: false, example: 0, description: 'Records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Records to take (1-20; clamped server-side)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  take?: number;
}

/** Pre-flight trust check for a federated address search: has mutual trust with this peer domain
 *  already been established? Drives the client's first-contact affordance — a "Connecting to
 *  <domain>…" banner shown only when a handshake is actually expected (the server knows whether a
 *  FederatedPeer 'trusted' row exists), rather than guessed from request latency. */
export class PeerTrustStatusDto {
  @ApiProperty({
    example: 'bbb.local',
    description: 'Peer domain (the part after @ in a federated address)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(63)
  domain: string;
}

/**
 * Update the current user's profile (nickname/bio). All fields optional; send only what changes.
 * account (account) cannot be changed here — identity changes go through a separate flow.
 */
export class UpdateProfileDto {
  @ApiProperty({
    required: false,
    example: 'Alice',
    description: 'Display name (1-30 chars; unicode/emoji allowed)',
  })
  @IsOptional()
  @IsDisplayName()
  name?: string;

  @ApiProperty({
    required: false,
    example: 'Hey there!',
    description: 'Bio (≤120 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'bio must be at most 120 chars' })
  bio?: string;
}

export class QueryUsersDto {
  @ApiProperty({
    type: Number,
    isArray: true,
    example: [1, 2, 3],
    description: 'List of user ids (≤100 per query)',
  })
  @IsArray()
  @ArrayMaxSize(100, { message: 'must less than 100 userIds per query' })
  @IsInt({ each: true })
  userIds: number[];
}

export class QueryValidThreadDto {
  @ApiProperty({
    example: 0,
    description: 'Number of records to skip (pagination)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;

  @ApiProperty({ example: 20, description: 'Number of records to take (1-50)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50, { message: 'take must be at most 50' })
  take: number;

  @ApiProperty({
    required: false,
    example: 100,
    description: 'Last id of the previous page (cursor, optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  lastId?: number;

  @ApiProperty({
    enum: MessageThreadType,
    required: false,
    description: 'Conversation type P2P|GROUP (optional filter)',
  })
  @IsOptional()
  type?: MessageThreadType;
}

/** Body for /user/query-thread/delta — pull ADD/DELETE deltas in (fromRevision, toRevision]
 *  (from exclusive, to inclusive). The client applies them in revision order. */
export class ThreadDeltaDto {
  @ApiProperty({ example: 0, description: 'From revision (exclusive)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fromRevision: number;

  @ApiProperty({ example: 5, description: 'To revision (inclusive)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  toRevision: number;
}

