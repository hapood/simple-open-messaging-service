import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CALL_SID_RE,
  CALL_SIGNAL_KINDS,
  type CallSignalKind,
} from '../calls/federated-call-protocol.js';

/** 1:1 WebRTC call request DTOs. The server is signaling coordinator + lifecycle owner only — it
 *  never carries media. Validation mirrors the message.dto convention (class-validator + @ApiProperty). */

/**
 * A callSid is a client-generated canonical lowercase RFC UUID — the call's idempotency key AND the
 * address every signaling frame carries. The shape is enforced at the DTO
 * boundary so a malformed/garbage id can never reach the in-memory map or become a clientMessageId.
 */
export { CALL_SID_RE } from '../calls/federated-call-protocol.js';

/** Caller initiates a call. `callSid` is the client-generated idempotency key + stable signaling
 *  address (mirrors Message.clientMessageId); a retried initiate with the same value re-rings the
 *  still-ringing call instead of creating a duplicate. */
export class InitiateCallDto {
  @ApiProperty({
    description:
      'Client-generated canonical lowercase RFC UUID — the call idempotency key + the address every signaling frame carries.',
  })
  @IsString()
  @MaxLength(36)
  @Matches(CALL_SID_RE, {
    message: 'callSid must be a canonical lowercase RFC UUID',
  })
  callSid!: string;

  @ApiProperty({
    example: 7,
    description:
      'The callee userId (must be a friend — share an active P2P thread).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  calleeUserId!: number;

  @ApiProperty({
    enum: ['AUDIO', 'VIDEO'],
    description: 'Call media direction.',
  })
  @IsIn(['AUDIO', 'VIDEO'])
  callType!: 'AUDIO' | 'VIDEO';
}

/** Address a call by its callSid (the callee learns it from the incoming ring; the caller minted it). */
export class CallSidDto {
  @ApiProperty({ description: 'The callSid addressing the call.' })
  @IsString()
  @MaxLength(36)
  @Matches(CALL_SID_RE, {
    message: 'callSid must be a canonical lowercase RFC UUID',
  })
  callSid!: string;
}

/** The callee accepts an incoming ring. */
export class AnswerCallDto extends CallSidDto {}

/** The callee's device acknowledges it is alerting the user (it received the `incoming` ring and is now
 *  ringing the UI) — lets the caller's UI show "Ringing…" instead of "Calling…". The server cannot
 *  otherwise know the callee device is alerting (receiving the SSE `incoming` only proves the socket
 *  arrived). Body is just `callSid` (same shape as {@link AnswerCallDto}); the call does NOT transition. */
export class RingingCallDto extends CallSidDto {}

/** Either party reports the media leg is up (DTLS-SRTP connected). This is the real connect authority —
 *  the basis for the call record's `startedAt`/duration (NOT `/calls/accept`, which only means the
 *  callee answered). Idempotent: the second party's report is a no-op. */
export class ConnectedCallDto extends CallSidDto {}

/** Permanently upgrade an established AUDIO call to VIDEO. This transition is idempotent and one-way for
 *  the lifetime of the call; turning a camera off later pauses only that participant's video track. */
export class UpgradeCallVideoDto extends CallSidDto {}

/** The callee declines an incoming ring. */
export class DeclineCallDto extends CallSidDto {}

/** The caller cancels a ringing call before the callee answers. */
export class CancelCallDto extends CallSidDto {}

/** Either party ends a connected (accepted) call. */
export class EndCallDto extends CallSidDto {
  @ApiProperty({
    required: false,
    enum: ['completed', 'timeout', 'failed'],
    description:
      'Why the call ended (advisory). "completed" is a normal hangup; "failed"/"timeout" mark a connect/answer failure (persisted as the `failed` call outcome).',
  })
  @IsOptional()
  @IsIn(['completed', 'timeout', 'failed'])
  endReason?: string;
}

/** Relay one WebRTC signaling frame to the peer. The payload is opaque to the server (relayed verbatim,
 *  never persisted) — SDP offer/answer, an ICE candidate, or camera enabled state. */
export class SignalCallDto {
  @ApiProperty({
    description:
      'Endpoint-generated canonical UUID for end-to-end signal idempotency. Reuse it when retrying the same logical signal.',
  })
  @IsString()
  @MaxLength(36)
  @Matches(CALL_SID_RE, {
    message: 'id must be a canonical lowercase RFC UUID',
  })
  id!: string;

  @ApiProperty({ description: 'The callSid this frame belongs to.' })
  @IsString()
  @MaxLength(36)
  @Matches(CALL_SID_RE, {
    message: 'callSid must be a canonical lowercase RFC UUID',
  })
  callSid!: string;

  @ApiProperty({
    example: 7,
    description:
      'The peer userId to relay to (must be the OTHER call participant).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toUserId!: number;

  @ApiProperty({
    enum: CALL_SIGNAL_KINDS,
    description: 'Signaling frame kind.',
  })
  @IsIn(CALL_SIGNAL_KINDS)
  kind!: CallSignalKind;

  @ApiProperty({
    description:
      'Opaque WebRTC payload (SDP / ICE candidate JSON). Relayed verbatim, never persisted.',
  })
  @IsString()
  @MaxLength(32768)
  payload!: string;
}
