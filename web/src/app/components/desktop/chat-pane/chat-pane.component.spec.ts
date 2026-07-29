import { Component, input, output, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideTransloco, provideTranslocoTranspiler } from '@jsverse/transloco';
import { By } from '@angular/platform-browser';
import { ChatPaneComponent } from './chat-pane.component';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { NavStateMachineService } from '../../../services/nav-state.service';
import { LayoutService } from '../../../services/layout.service';
import { InlineTranslocoLoader } from '../../../i18n/transloco.loader';
import { CspSafeIcuTranspiler } from '../../../i18n/csp-safe-icu.transpiler';
import type { ConversationItem } from '../../../services/model';

/**
 * A/B double-buffer coordinator — regression + behavior coverage for the app's core thread-switch logic.
 *
 * The coordinator (the constructor effect in chat-pane.component.ts) routes an open-thread target to one of:
 *   close (teardownKernel fg) · fg-resident (reset fg) · bg-resident (reset bg → promote) ·
 *   fresh bind (slot.set bg → await ready → promote) · missing (reload once, else closeChat).
 *
 * The load-bearing invariant under test: panes are NEVER destroyed on a switch — only reset in place — so
 * re-selecting a thread already bound to a (possibly idled) pane must drive that pane's `reset()`, never a
 * no-op `slot.set` that would strand the switch (`ready` would never fire because the input-keyed init
 * effect does not re-run on an unchanged ConversationItem). That strand was the original bug.
 *
 * MessageThreadComponent is stood in by StubThreadComponent so the coordinator's ROUTING + the `fgSlot`
 * cross-fade trigger can be asserted without the kernel / HttpItemSource / virtual scroll (which need
 * real-browser rendering and are exercised in the playground). The host cross-fades a pane in only after it
 * emits `ready`; tests emit `ready` manually to drive `promote`.
 */
@Component({ selector: 'app-message-thread', template: '', standalone: true })
class StubThreadComponent {
  readonly threadId = input<number>();
  readonly userMsgTrd = input<ConversationItem>();
  readonly nativeComposerActive = input(false);
  readonly ready = output<number>();
  readonly reset = jasmine.createSpy('reset');
  readonly teardownKernel = jasmine.createSpy('teardownKernel');
  /** Defaults to WARM (the common post-promote / resident case); a test flips it false to simulate a close
   *  having idled the kernel, so the fg-resident branch's cold path can be exercised. */
  readonly isWarm = jasmine.createSpy('isWarm').and.returnValue(true);
}

@Component({ selector: 'app-chat-empty', template: '', standalone: true })
class StubEmptyComponent {}

const item = (threadId: number, name: string) =>
  ({ id: threadId, threadId, type: 'P2P', peerUser: { id: threadId, account: name } } as ConversationItem);

describe('ChatPaneComponent A/B coordinator', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<ChatPaneComponent>>;
  let comp: ChatPaneComponent;
  let openThreadId: WritableSignal<number | undefined>;
  let items: WritableSignal<ConversationItem[]>;
  let status: WritableSignal<string>;
  let mode: WritableSignal<'compact' | 'medium' | 'expanded'>;
  let loadSpy: jasmine.Spy;
  let closeChatSpy: jasmine.Spy;

  beforeEach(() => {
    openThreadId = signal<number | undefined>(undefined);
    items = signal<ConversationItem[]>([item(1, 'alice'), item(2, 'bob'), item(3, 'carol')]);
    status = signal('READY');
    // Default to expanded (the cross-fade path): existing coordinator assertions are layout-agnostic, and the
    // loading-gate regression below opts into compact explicitly.
    mode = signal<'compact' | 'medium' | 'expanded'>('expanded');
    loadSpy = jasmine.createSpy('load');
    closeChatSpy = jasmine.createSpy('closeChat');

    TestBed.configureTestingModule({
      imports: [ChatPaneComponent],
      providers: [
        provideZonelessChangeDetection(),
        // The pane-loading overlay renders `{{ 'chat.loading' | transloco }}` as its accessible name, so the
        // template needs the inline loader when the spinner branch is exercised by the gate tests below.
        provideTransloco({
          config: {
            availableLangs: [{ id: 'en', label: 'English' }, { id: 'zh-CN', label: 'Simplified Chinese' }],
            defaultLang: 'en',
            reRenderOnLangChange: true,
          },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        // Minimal mock ConvList: real signals the coordinator reads, spy for the actions it takes.
        { provide: ConversationListService, useValue: { openThreadId, items, status, load: loadSpy } },
        {
          provide: NavStateMachineService,
          useValue: { closeChat: closeChatSpy, consumeChatTransition: () => 'standard' },
        },
        { provide: LayoutService, useValue: { mode } },
      ],
    });
    // Swap the heavy real panes for stubs so the coordinator's routing can be asserted in isolation.
    TestBed.overrideComponent(ChatPaneComponent, {
      remove: { imports: [MessageThreadComponent, ChatEmptyComponent] },
      add: { imports: [StubThreadComponent, StubEmptyComponent] },
    });
    fixture = TestBed.createComponent(ChatPaneComponent);
    comp = fixture.componentInstance;
  });

  afterEach(() => fixture.destroy());

  /** Drive change detection + drain the zoneless scheduler (effects + microtasks). */
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  /** Set the open thread id and let the coordinator effect run. */
  async function open(tid: number | undefined): Promise<void> {
    openThreadId.set(tid);
    await settle();
  }

  /** The stub pane currently bound to `tid`, or undefined if none is mounted for it. */
  function pane(tid: number): StubThreadComponent | undefined {
    return fixture.debugElement
      .queryAll(By.directive(StubThreadComponent))
      .map((d) => d.componentInstance as StubThreadComponent)
      .find((s) => s.threadId() === tid);
  }

  /** Emit the pane's `ready` (kernel finished) and let `promote` run. */
  async function ready(tid: number): Promise<void> {
    const p = pane(tid);
    if (!p) throw new Error(`no pane bound to thread ${tid}`);
    p.ready.emit(tid);
    await settle();
  }

  // ----------------------------- close -----------------------------

  it('close → idles the foreground kernel (teardownKernel); the component STAYS mounted', async () => {
    await open(1);
    const pane1 = pane(1)!;
    await ready(1); // promote → pane1 foreground (slot B)
    expect(comp.fgSlot()).toBe('B');

    await open(undefined);

    expect(pane1.teardownKernel).toHaveBeenCalledTimes(1);
    expect(pane(1)).toBe(pane1); // SAME instance — not destroyed / recreated
  });

  // ----------------------------- compact loading gate (the mobile regression) -----------------------------

  it('compact close→open: shows the spinner while the new pane initializes, then hides it on promote', async () => {
    mode.set('compact');
    await open(1);
    // The `.compact` class drives the CSS that snaps the outgoing pane away (spinner↔chatpane, no
    // chatpane↔chatpane cross-fade) — lock the binding so the demote can't silently regress to a dissolve.
    expect(fixture.debugElement.query(By.css('.chat-pane'))!.nativeElement.classList.contains('compact'))
      .toBe(true);
    await ready(1); // promote → fg B (slot B = 1)
    expect(comp.fgSlot()).toBe('B');
    expect(comp.showLoading()).toBe(false);

    await open(undefined); // close: teardownKernel fg, but slot B KEEPS thread 1
    expect(comp.showLoading()).toBe(false); // !active → pane-empty, not the spinner

    await open(2); // re-open a different thread: fresh bind to slot A (hidden), fg stays B (still bound to 1)
    expect(comp.fgSlot()).toBe('B');
    // The foreground still holds the OUTGOING thread 1 while thread 2 initializes in the background — the
    // spinner must cover it so the mobile slide-in never reveals stale content.
    expect(comp.showLoading()).toBe(true);

    await ready(2); // promote → fg A (slot A = 2)
    expect(comp.fgSlot()).toBe('A');
    expect(comp.showLoading()).toBe(false); // foreground now matches the open thread
  });

  it('expanded close→open: NO spinner mid-switch — the outgoing pane cross-fades (desktop stays as-is)', async () => {
    mode.set('expanded');
    await open(1);
    await ready(1); // fg B (slot B = 1)
    await open(undefined);
    await open(2); // fg still B (slot B = 1, stale); thread 2 initializes in background slot A
    expect(comp.showLoading()).toBe(false); // cross-fade path: fgItem() is the stale thread 1 → truthy
    await ready(2);
    expect(comp.showLoading()).toBe(false);
  });

  it('compact direct switch (no close) also gates the spinner until promote', async () => {
    mode.set('compact');
    await open(1);
    await ready(1); // fg B (slot B = 1)
    await open(2); // direct switch 1→2 (e.g. a notification jump): fresh bind to slot A, fg stays B (stale 1)
    expect(comp.showLoading()).toBe(true); // stale fg 1 ≠ open thread 2
    await ready(2); // promote → fg A
    expect(comp.showLoading()).toBe(false);
  });

  it('compact re-open the SAME thread: NO spinner — the stale foreground IS the right thread', async () => {
    mode.set('compact');
    await open(1);
    await ready(1); // fg B (slot B = 1)
    await open(undefined); // close: teardownKernel fg → cold; slot B keeps 1
    pane(1)!.isWarm.and.returnValue(false); // mirror the real cold pane so the fg-resident branch re-inits
    await open(1); // re-open same → fg-resident: reset() fg (slot B already = 1)
    expect(comp.showLoading()).toBe(false); // fg slot 1 === open thread 1 → no spinner, no wrong-chat reveal
    await ready(1);
    expect(comp.showLoading()).toBe(false);
  });

  // ----------------------------- fresh bind -----------------------------

  it('first open → binds the background slot and promotes on ready (reset NOT called: fresh, not resident)', async () => {
    expect(comp.fgSlot()).toBe('A');
    await open(1);
    const pane1 = pane(1);
    expect(pane1).withContext('bg pane mounted for the new thread').toBeTruthy();
    expect(pane1!.reset).not.toHaveBeenCalled();
    await ready(1);
    expect(comp.fgSlot()).toBe('B');
  });

  it('switching to a different new thread alternates to the other slot', async () => {
    await open(1);
    await ready(1); // slot B, fg B
    await open(2); // alternates → slot A
    expect(pane(2)).toBeTruthy();
    expect(pane(2)!.reset).not.toHaveBeenCalled(); // 2 was not resident → fresh bind
    await ready(2);
    expect(comp.fgSlot()).toBe('A');
  });

  // ----------------------------- resident re-select (the regression) -----------------------------

  it('REGRESSION: re-selecting a thread resident in the BACKGROUND slot routes to reset() (not a no-op bind)', async () => {
    await open(1);
    await ready(1); // slot B = 1, fg B
    await open(2);
    await ready(2); // slot A = 2, fg A → pane1 (thread 1) demoted to bg, still mounted
    const pane1 = pane(1)!;
    expect(pane1).withContext('demoted pane stays mounted — never destroyed').toBeTruthy();

    await open(1); // 1 is RESIDENT in the bg slot → must reset, not strand
    expect(pane1.reset).toHaveBeenCalledTimes(1);
    expect(pane(1)).toBe(pane1); // SAME instance — reset in place, not remounted

    await ready(1);
    expect(comp.fgSlot()).toBe('B');
  });

  it('re-selecting the open WARM foreground thread is a no-op (no reset, no cross-fade)', async () => {
    await open(1);
    await ready(1); // fg B = thread 1, warm
    const pane1 = pane(1)!;

    await open(1); // fgTid === target AND warm → nothing to do
    expect(pane1.reset).not.toHaveBeenCalled();
    expect(comp.fgSlot()).toBe('B'); // still foreground
  });

  it('reopen the SAME thread after a close (COLD fg) → reset() re-initializes in place', async () => {
    await open(1);
    await ready(1);
    const pane1 = pane(1)!;
    await open(undefined); // close → teardownKernel pane1 (kernel idled → cold)
    expect(pane1.teardownKernel).toHaveBeenCalledTimes(1);
    pane1.isWarm.and.returnValue(false); // simulate the idled (cold) kernel

    await open(1); // fg still bound to 1, now cold → reset re-initializes
    expect(pane1.reset).toHaveBeenCalledTimes(1);
    expect(pane(1)).toBe(pane1); // not destroyed
  });

  // ----------------------------- no-destroy invariant -----------------------------

  it('the two resident panes persist (never destroyed) while flipping between two threads', async () => {
    await open(1);
    await ready(1);
    const p1 = pane(1); // slot B
    await open(2);
    await ready(2);
    const p2 = pane(2); // slot A
    await open(1);
    await ready(1); // resident flip → slot B
    await open(2);
    await ready(2); // resident flip → slot A
    await open(1);
    await ready(1);

    expect(pane(1)).toBe(p1); // SAME instance across every flip — never destroyed
    expect(pane(2)).toBe(p2);
  });

  // ----------------------------- pending / ready semantics -----------------------------

  it('a stale `ready` (superseded target) is ignored; only the in-flight switch promotes', async () => {
    await open(1); // slot B = 1, pending {1,B}; NOT promoted yet
    const paneB = pane(1)!;
    await open(2); // supersedes → slot B = 2, pending {2,B}; paneB now shows 2
    expect(comp.fgSlot()).toBe('A'); // nothing promoted

    paneB.ready.emit(1); // stale ready for the OLD target 1
    await settle();
    expect(comp.fgSlot()).toBe('A'); // still not promoted — stale ready discarded

    await ready(2); // the in-flight target completes
    expect(comp.fgSlot()).toBe('B'); // NOW promoted
  });

  // ----------------------------- missing thread -----------------------------

  it('missing thread, list READY, first attempt → reload the list once (no pane, no close)', async () => {
    await open(99); // 99 absent from items
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(closeChatSpy).not.toHaveBeenCalled();
    expect(pane(99)).toBeUndefined();
  });

  it('missing thread persists after the reload → closeChat (give up)', async () => {
    await open(99);
    expect(loadSpy).toHaveBeenCalledTimes(1);
    // Simulate the reload completing with 99 STILL absent (new array ref → effect re-runs):
    items.set([item(1, 'alice'), item(2, 'bob')]);
    await settle();
    expect(closeChatSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledTimes(1); // not reloaded a second time
  });

  it('missing thread while the list is LOADING → waits; reloads once it becomes READY', async () => {
    status.set('LOADING');
    await open(99);
    expect(loadSpy).not.toHaveBeenCalled();
    expect(closeChatSpy).not.toHaveBeenCalled();

    status.set('READY');
    await settle();
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
