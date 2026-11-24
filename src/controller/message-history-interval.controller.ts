import {
  Controller,
  Query,
  Request,
  Sse,
  type MessageEvent,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { catchError, map, of, throwError, type Observable } from 'rxjs';
import { AccountThreadStateService } from '../account-thread-state/account-thread-state.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { Raw } from '../common/raw.decorator.js';
import { withSseHeartbeat } from '../common/sse-heartbeat.js';
import { HistoryIntervalQueryDto } from '../dto/history-interval.dto.js';
import { HistoryIntervalEvictedError } from '../message/history-interval-events.service.js';
import { HistoryIntervalService } from '../message/history-interval.service.js';

@ApiTags('message')
@Controller()
export class MessageHistoryIntervalController {
  constructor(
    private readonly participants: AccountThreadStateService,
    private readonly historyIntervals: HistoryIntervalService,
  ) {}

  @Raw()
  @ApiBearerAuth()
  @Sse('message/history-interval')
  @ApiOperation({
    summary:
      'Subscribe to one mounted server-gap interval for committed history wakes',
  })
  async historyInterval(
    @Request() req: FastifyRequest,
    @Query() dto: HistoryIntervalQueryDto,
  ): Promise<Observable<MessageEvent>> {
    if (
      !Number.isSafeInteger(dto.threadId) ||
      dto.threadId < 1 ||
      !Number.isSafeInteger(dto.left) ||
      !Number.isSafeInteger(dto.right) ||
      dto.left < 0 ||
      dto.right <= dto.left
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'history interval must satisfy 0 <= left < right',
      );
    }
    const participant = await this.participants.findActiveParticipantWithThread(
      req.user.userId,
      dto.threadId,
    );
    if (participant === null) {
      throw new BusinessException(
        BusinessCode.THREAD_NOT_FOUND,
        `no thread [${dto.threadId}]`,
      );
    }
    const stream = await this.historyIntervals.open(
      req.user.userId,
      dto.threadId,
      dto.left,
      dto.right,
    );
    return stream.pipe(
      map(
        (data): MessageEvent => ({
          type: 'MESSAGE_HISTORY_INTERVAL',
          data,
        }),
      ),
      catchError((error: unknown) =>
        error instanceof HistoryIntervalEvictedError
          ? of<MessageEvent>({
              type: 'MESSAGE_HISTORY_INTERVAL_EVICTED',
              data: {
                code: BusinessCode.HISTORY_INTERVAL_EVICTED,
                message: error.message,
              },
            })
          : throwError(() => error),
      ),
      withSseHeartbeat(),
    );
  }
}
