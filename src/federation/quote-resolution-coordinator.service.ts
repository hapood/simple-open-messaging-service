import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import { MessageService } from '../message/message.service.js';
import { SseService } from '../gateway/sse.service.js';
import { isThreadMutuallyAuthorized } from '../business/relationship/shared/relationship-authorization.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';
import { FederationThreadRoundSchedulerService } from './federation-thread-round-scheduler.service.js';

/** User-scoped asynchronous quote reads. Completion observes committed sync rounds, never polls. */
@Injectable()
export class QuoteResolutionCoordinatorService implements OnModuleDestroy {
  private readonly flights = new Map<
    string,
    { requestId: string; cancel: () => void }
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly messages: MessageService,
    private readonly scheduler: FederationThreadRoundSchedulerService,
    private readonly sse: SseService,
  ) {}

  async start(
    userId: number,
    selector: { threadId: number; messageSeq: number },
  ) {
    if (
      !selector ||
      Object.keys(selector).length !== 2 ||
      !Number.isSafeInteger(selector.threadId) ||
      selector.threadId < 1 ||
      !Number.isSafeInteger(selector.messageSeq) ||
      selector.messageSeq < 1
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'invalid quote selector',
      );
    const read = async () => {
      if (
        !(await isThreadMutuallyAuthorized(
          this.database.db,
          userId,
          selector.threadId,
        ))
      )
        throw new BusinessException(
          BusinessCode.FORBIDDEN,
          'thread is unavailable',
        );
      const page = await this.messages.queryClientMessagePage(userId, {
        threadId: selector.threadId,
        after: selector.messageSeq - 1,
        through: selector.messageSeq,
        take: 1,
      });
      const parent = page.messages.find((m) => m.seq === selector.messageSeq);
      const quote =
        parent &&
        parent.contentType !== 'TOMB' &&
        parseTextMessageContent(parent.content)?.quote;
      if (!quote)
        throw new BusinessException(
          BusinessCode.NOT_FOUND,
          'quoted message is unavailable',
        );
      return quote;
    };
    const quote = await read();
    if (quote.status !== 'PENDING')
      return { status: 'READY' as const, result: quote };
    const key = JSON.stringify([
      userId,
      selector.threadId,
      selector.messageSeq,
    ]);
    const existing = this.flights.get(key);
    if (existing)
      return { status: 'PENDING' as const, requestId: existing.requestId };
    if (this.flights.size >= 1000)
      throw new BusinessException(
        BusinessCode.FORBIDDEN,
        'too many pending quote resolutions',
      );
    const requestId = randomUUID();
    let checking = false;
    let dirty = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsubscribe = () => {};
    const cancel = () => {
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      this.flights.delete(key);
    };
    const fail = () => {
      if (finished) return;
      cancel();
      this.sse.onQuoteResolution(userId, 'QUOTE_FAILED', {
        requestId,
        reason: 'TEMPORARILY_UNAVAILABLE',
      });
    };
    const check = async () => {
      if (finished) return;
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        do {
          dirty = false;
          const result = await read();
          if (!finished && result.status !== 'PENDING') {
            cancel();
            this.sse.onQuoteResolution(userId, 'QUOTE_RESOLVED', {
              requestId,
              result,
            });
          }
        } while (dirty && !finished);
      } catch {
        fail();
      } finally {
        checking = false;
      }
    };
    unsubscribe = this.scheduler.observeCompletions((threadId) => {
      if (threadId === selector.threadId) void check();
    });
    timer = setTimeout(fail, 20_000);
    this.flights.set(key, { requestId, cancel });
    void (async () => {
      const [source] = await this.database.db
        .select({
          domain: tables.identityNamespace.domain,
          namespaceId: tables.identityNamespace.id,
        })
        .from(tables.message)
        .innerJoin(
          tables.identityNamespace,
          eq(tables.identityNamespace.id, tables.message.sourceNamespaceId),
        )
        .where(
          and(
            eq(tables.message.threadId, selector.threadId),
            eq(tables.message.seq, selector.messageSeq),
          ),
        )
        .limit(1);
      if (!source) return fail();
      if (finished) return;
      await this.scheduler.requestSourceRefresh(
        selector.threadId,
        source.domain,
        source.namespaceId,
      );
      await check();
    })().catch(fail);
    return { status: 'PENDING' as const, requestId };
  }

  onModuleDestroy() {
    for (const flight of this.flights.values()) flight.cancel();
  }
}
