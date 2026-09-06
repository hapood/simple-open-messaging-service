import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import { WebsocketService } from './websocket.service';
import { ResolutionDispatcher, ResolutionStart } from './resolution-dispatcher';
import type { StandardResponse } from './model';
import {
  parseTextMessageContent,
  TextMessageContent,
} from '../../../../shared/text-message-content';

type Quote = NonNullable<TextMessageContent['quote']>;
type Selector = { threadId: number; messageSeq: number };

@Injectable({ providedIn: 'root' })
export class QuoteResolutionService {
  private readonly recent = new Map<
    string,
    { expires: number; request: Observable<Quote> }
  >();
  private readonly dispatcher: ResolutionDispatcher<Selector, Quote>;
  constructor(http: HttpClient, realtime: WebsocketService) {
    this.dispatcher = new ResolutionDispatcher<Selector, Quote>(
      realtime,
      async (selector) => {
        const response = await firstValueFrom(
          http.post<StandardResponse<ResolutionStart<Quote>>>(
            `${apiPrefix}/message/quote-resolution`,
            selector,
          ),
        );
        if (response.code !== 0 || !response.data)
          throw new Error(response.message);
        return response.data;
      },
      (event) => {
        const value = event as {
          event?: string;
          status?: number;
          data?: { requestId?: string; result?: unknown; reason?: string };
        };
        if (value.status !== 0 || typeof value.data?.requestId !== 'string')
          return null;
        if (
          value.event === 'QUOTE_FAILED' &&
          typeof value.data.reason === 'string'
        )
          return { requestId: value.data.requestId, reason: value.data.reason };
        if (value.event !== 'QUOTE_RESOLVED') return null;
        const result = parseTextMessageContent(
          JSON.stringify({ text: '', quote: value.data.result }),
        )?.quote;
        return result ? { requestId: value.data.requestId, result } : null;
      },
    );
    realtime.helloGeneration$.subscribe(() => this.recent.clear());
  }

  resolve(selector: Selector): Observable<Quote> {
    const key = JSON.stringify([selector.threadId, selector.messageSeq]);
    const recent = this.recent.get(key);
    if (recent && recent.expires > Date.now()) return recent.request;
    const request = this.dispatcher.resolve({
      threadId: selector.threadId,
      messageSeq: selector.messageSeq,
    });
    this.recent.delete(key);
    this.recent.set(key, { expires: Date.now() + 5000, request });
    while (this.recent.size > 1000)
      this.recent.delete(this.recent.keys().next().value!);
    return request;
  }
}
