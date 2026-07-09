import { Component, input, output, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { ChatPaneComponent } from './chat-pane.component';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { NavStateMachineService } from '../../../services/nav-state.service';
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
  let loadSpy: jasmine.Spy;
  let closeChatSpy: jasmine.Spy;

  beforeEach(() => {
    openThreadId = signal<number | undefined>(undefined);
    items = signal<ConversationItem[]>([item(1, 'alice'), item(2, 'bob'), item(3, 'carol')]);
    status = signal('READY');
    loadSpy = jasmine.createSpy('load');
    closeChatSpy = jasmine.createSpy('closeChat');

    TestBed.configureTestingModule({
      imports: [ChatPaneComponent],
      providers: [
        provideZonelessChangeDetection(),
        // Minimal mock ConvList: real signals the coordinator reads, spy for the actions it takes.
        { provide: ConversationListService, useValue: { openThreadId, items, status, load: loadSpy } },
        { provide: NavStateMachineService, useValue: { closeChat: closeChatSpy } },
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
