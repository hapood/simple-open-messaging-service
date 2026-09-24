import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  MESSAGE_THREAD_ADAPTER,
  SearchMessagesRequest,
} from '../message-thread/message-thread-adapter';
import { MessageSearchComponent } from './message-search.component';

describe('MessageSearchComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  it('counts all matches and fetches older pages at the navigation boundary', () => {
    const searchMessages = vi.fn((request: SearchMessagesRequest) => {
      const start = request.lastSeq === undefined ? 55 : request.lastSeq - 1;
      const seqs = Array.from(
        { length: Math.min(50, start) },
        (_, i) => start - i,
      );
      return of({
        code: 0,
        message: 'successful',
        data: seqs.map((seq) => ({ seq, createdAt: 1 })),
        totalCount: 55,
        hasMore: seqs.at(-1)! > 1,
      });
    });
    TestBed.overrideProvider(MESSAGE_THREAD_ADAPTER, {
      useValue: { searchMessages },
    });
    const fixture = TestBed.createComponent(MessageSearchComponent);
    fixture.componentRef.setInput('threadId', 11);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const jumps: number[] = [];
    component.jumpTo.subscribe((seq) => jumps.push(seq));
    component.keyword = 'pagehit';
    component.onInput();
    vi.advanceTimersByTime(300);
    expect(component.countLabel()).toBe('55 / 55');
    for (let i = 0; i < 50; i++) component.prev();
    expect(searchMessages).toHaveBeenLastCalledWith({
      threadId: 11,
      keyword: 'pagehit',
      take: 50,
      lastSeq: 6,
    });
    expect(jumps.at(-1)).toBe(5);
    expect(component.countLabel()).toBe('5 / 55');
    for (let i = 0; i < 4; i++) component.prev();
    expect(component.countLabel()).toBe('1 / 55');
    expect(component.canPrev()).toBe(false);
    component.next();
    expect(component.countLabel()).toBe('2 / 55');
    fixture.destroy();
  });

  it('ignores results from a previous keyword after input changes', () => {
    const old = new Subject<{
      code: number;
      message: string;
      data: { seq: number; createdAt: number }[];
      totalCount: number;
      hasMore: boolean;
    }>();
    const searchMessages = vi.fn((request: SearchMessagesRequest) =>
      request.keyword === 'old'
        ? old.asObservable()
        : of({
            code: 0,
            message: 'successful',
            data: [{ seq: 3, createdAt: 1 }],
            totalCount: 1,
            hasMore: false,
          }),
    );
    TestBed.overrideProvider(MESSAGE_THREAD_ADAPTER, {
      useValue: { searchMessages },
    });
    const fixture = TestBed.createComponent(MessageSearchComponent);
    fixture.componentRef.setInput('threadId', 11);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    component.keyword = 'old';
    component.onInput();
    vi.advanceTimersByTime(300);
    component.keyword = 'new';
    component.onInput();
    vi.advanceTimersByTime(300);
    old.next({
      code: 0,
      message: 'successful',
      data: [{ seq: 9, createdAt: 1 }],
      totalCount: 2,
      hasMore: false,
    });
    expect(component.countLabel()).toBe('1 / 1');
    fixture.destroy();
  });
});
