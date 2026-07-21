import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NotifPopupService } from './notif-popup.service';
import type { NotificationDescriptor } from './notification-descriptor.model';

function descriptor(tag: string, opts: { body?: string; kind?: string } = {}): NotificationDescriptor {
  return {
    tag,
    kind: opts.kind ?? 'message-summary',
    title: 'SOMS',
    body: opts.body ?? 'hi',
    lang: 'en',
    icon: null,
    renotify: false,
    actions: [],
    data: {},
  };
}

describe('NotifPopupService', () => {
  let svc: NotifPopupService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), NotifPopupService],
    });
    svc = TestBed.inject(NotifPopupService);
  });

  it('show adds non-clear cards to the signal', () => {
    expect(svc.popups()).toEqual([]);
    svc.show([descriptor('soms-away', { body: 'Alice sent you 1 message' })]);
    expect(svc.popups().map((d) => d.tag)).toEqual(['soms-away']);
    expect(svc.popups()[0].body).toBe('Alice sent you 1 message');
  });

  it('show with a repeated tag REPLACES in place (never stacks)', () => {
    svc.show([descriptor('soms-away', { body: 'old' })]);
    svc.show([descriptor('soms-away', { body: 'new' })]);
    expect(svc.popups().length).toBe(1);
    expect(svc.popups()[0].body).toBe('new');
  });

  it('a kind:clear descriptor dismisses the tagged card', () => {
    svc.show([descriptor('soms-away', { body: 'x' })]);
    expect(svc.popups().length).toBe(1);
    svc.show([descriptor('soms-away', { kind: 'clear' })]);
    expect(svc.popups()).toEqual([]);
  });

  it('dismiss(tag) removes only that card', () => {
    svc.show([descriptor('a'), descriptor('b')]);
    svc.dismiss('a');
    expect(svc.popups().map((d) => d.tag)).toEqual(['b']);
  });

  it('clear() empties all cards', () => {
    svc.show([descriptor('a'), descriptor('b')]);
    svc.clear();
    expect(svc.popups()).toEqual([]);
  });
});
