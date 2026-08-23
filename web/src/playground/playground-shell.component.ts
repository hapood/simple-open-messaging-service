import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { MessageThreadComponent } from '../app/components/message-thread/friend-message.component';
import type { ConversationItem } from '../app/services/model';
import { ThemeService } from '../app/services/theme.service';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';
import { PeerProfileComponent } from '../app/components/peer-profile/peer-profile.component';
import { GroupInfoComponent } from '../app/components/group-info/group-info.component';
import { NavStateMachineService } from '../app/services/nav-state.service';
import { PlaygroundConversationList } from './playground-conversation-list.mock';
import {
  PlaygroundCallState,
  type PlaygroundCallResponse,
} from './playground-call.mock';

const DEMO_CONVERSATION = {
  id: 1,
  threadId: 1,
  type: 'P2P',
  alias: null,
  unreadCount: 0,
  lastMessageSeq: 100,
  friendshipActive: true,
  conversationState: 'ACTIVE',
  peerUser: {
    id: 2,
    account: 'alice',
    bio: 'Product designer · Shanghai',
    name: 'Alice',
    avatar: '',
    domain: '',
  },
  group: {},
} as ConversationItem;

const DEMO_INVITABLE_FRIEND = {
  ...DEMO_CONVERSATION,
  id: 6,
  threadId: 6,
  peerUser: {
    id: 6,
    account: 'liam',
    bio: 'Android engineer · Hangzhou',
    name: 'Liam',
    avatar: '',
    domain: '',
  },
} as ConversationItem;

const DEMO_GROUP_CONVERSATION = {
  id: 2,
  threadId: 2,
  type: 'GROUP',
  alias: null,
  unreadCount: 0,
  mentionUnread: [],
  lastMessageAt: 0,
  lastMessageSeq: 100,
  lastMessagePreview: null,
  lastMessageSenderId: null,
  lastReadSeq: null,
  muted: false,
  pinned: false,
  pinnedAt: null,
  clearedSeq: null,
  role: 'OWNER',
  conversationState: 'ACTIVE',
  peerUser: DEMO_CONVERSATION.peerUser,
  group: {
    id: 2,
    threadId: 2,
    account: '!playground',
    name: 'Playground Team',
    ownerId: 1,
    description: 'Alice · Maya · Noah · You',
    avatar: '',
    domain: '',
    profileRev: 1,
    dissolvedAt: null,
    createdAt: 0,
    updatedAt: 0,
    memberCount: 5,
    groupMetaFeedId: '0',
  },
} as ConversationItem;

type KernelFieldKey =
  | 'initBatch'
  | 'mountItem'
  | 'thresholdFloor'
  | 'vhExtra'
  | 'edge';

@Component({
  selector: 'app-playground-shell',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    TranslocoModule,
    MessageThreadComponent,
    PeerProfileComponent,
    GroupInfoComponent,
  ],
  template: `
    <main class="playground-shell">
      <section class="playground-chat" aria-label="Chatbox preview">
        <app-message-thread
          #chatThread
          [threadId]="conversation().threadId"
          [userMsgTrd]="conversation()"
          [nativeComposerActive]="true"
        />
      </section>

      @if (asidePanel()) {
        <button
          class="playground-profile-backdrop"
          type="button"
          (click)="nav.closeAside()"
          aria-label="Close contact info"
        ></button>
        <aside class="playground-profile" aria-label="Contact info">
          @switch (asidePanel()) {
            @case ('profile') {
              <app-peer-profile />
            }
            @case ('group-info') {
              <app-group-info />
            }
          }
        </aside>
      }

      <button
        #settingsButton
        class="playground-settings-button"
        [class.panel-open]="panelOpen()"
        type="button"
        (pointerdown)="onSettingsButtonDown($event)"
        aria-label="Demo settings (draggable)"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
      @if (panelOpen()) {
        <button
          class="playground-backdrop"
          type="button"
          (click)="panelOpen.set(false)"
          aria-label="Close demo settings"
        ></button>
      }
      <aside class="playground-panel" [class.open]="panelOpen()">
        <header>
          <div>
            <h2>Virtual Scroll Playground</h2>
            <p>Production chatbox · mock transport</p>
          </div>
          <button
            mat-icon-button
            type="button"
            (click)="panelOpen.set(false)"
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <mat-accordion multi>
          <mat-expansion-panel expanded>
            <mat-expansion-panel-header
              ><mat-panel-title>{{
                'playground.general' | transloco
              }}</mat-panel-title></mat-expansion-panel-header
            >
            <span class="field-label">{{
              'playground.language' | transloco
            }}</span>
            <mat-button-toggle-group
              [value]="i18n.getActiveLang()"
              [attr.aria-label]="'playground.language' | transloco"
              (change)="i18n.setActiveLang($event.value)"
            >
              <mat-button-toggle value="en">English</mat-button-toggle>
              <mat-button-toggle value="zh-CN">简体中文</mat-button-toggle>
            </mat-button-toggle-group>
            <span class="field-label">{{
              'playground.conversationType' | transloco
            }}</span>
            <mat-button-toggle-group
              [value]="conversation().type"
              [attr.aria-label]="'playground.conversationType' | transloco"
              (change)="setConversationType($event.value)"
            >
              <mat-button-toggle value="P2P">{{
                'playground.directChat' | transloco
              }}</mat-button-toggle>
              <mat-button-toggle value="GROUP">{{
                'playground.groupChat' | transloco
              }}</mat-button-toggle>
            </mat-button-toggle-group>
            <span class="field-label">{{
              'playground.callResponse' | transloco
            }}</span>
            <mat-button-toggle-group
              [value]="callState.opponentResponse()"
              [attr.aria-label]="'playground.callResponse' | transloco"
              (change)="setCallResponse($event.value)"
            >
              <mat-button-toggle value="decline">{{
                'playground.callDecline' | transloco
              }}</mat-button-toggle>
              <mat-button-toggle value="busy">{{
                'playground.callBusy' | transloco
              }}</mat-button-toggle>
              <mat-button-toggle value="no-answer">{{
                'playground.callNoAnswer' | transloco
              }}</mat-button-toggle>
              <mat-button-toggle value="accept">{{
                'playground.callAccept' | transloco
              }}</mat-button-toggle>
            </mat-button-toggle-group>
            <p>{{ 'playground.callResponseHint' | transloco }}</p>
            <mat-slide-toggle
              [checked]="!!conversation().muted"
              (change)="setMuted($event.checked)"
              >{{ 'playground.muted' | transloco }}</mat-slide-toggle
            >
            <mat-slide-toggle
              [checked]="!!conversation().blocked"
              (change)="setBlocked($event.checked)"
              >{{ 'playground.blocked' | transloco }}</mat-slide-toggle
            >
            @if (conversation().blocked && conversation().muted) {
              <p>{{ 'playground.blockedOverridesMuted' | transloco }}</p>
            }
          </mat-expansion-panel>

          <mat-expansion-panel expanded>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Theme</mat-panel-title
              ></mat-expansion-panel-header
            >
            <mat-button-toggle-group
              [value]="theme.mode()"
              aria-label="Theme"
              (change)="theme.setMode($event.value)"
            >
              <mat-button-toggle value="system">System</mat-button-toggle>
              <mat-button-toggle value="light">Light</mat-button-toggle>
              <mat-button-toggle value="dark">Dark</mat-button-toggle>
            </mat-button-toggle-group>
          </mat-expansion-panel>

          <mat-expansion-panel expanded>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Conversation</mat-panel-title
              ></mat-expansion-panel-header
            >
            @if (conversation().type === 'P2P') {
              <span class="field-label">Opponent replies per message</span>
              <mat-button-toggle-group
                [value]="runtime.opponentPushCount()"
                aria-label="Opponent replies per message"
                (change)="runtime.opponentPushCount.set($event.value)"
              >
                @for (count of [0, 1, 2, 5]; track count) {
                  <mat-button-toggle [value]="count">{{
                    count
                  }}</mat-button-toggle>
                }
              </mat-button-toggle-group>
            } @else {
              <span class="field-label">Group replies per message</span>
              <mat-button-toggle-group
                [value]="runtime.groupPushCount()"
                aria-label="Group replies per message"
                (change)="runtime.groupPushCount.set($event.value)"
              >
                @for (count of [0, 1, 2, 5]; track count) {
                  <mat-button-toggle [value]="count">{{
                    count
                  }}</mat-button-toggle>
                }
              </mat-button-toggle-group>
              <span class="field-label">Active group senders</span>
              <mat-button-toggle-group
                [value]="runtime.groupSenderCount()"
                aria-label="Active group senders"
                (change)="setGroupSenderCount($event.value)"
              >
                @for (count of [2, 3, 4]; track count) {
                  <mat-button-toggle [value]="count">{{
                    count
                  }}</mat-button-toggle>
                }
              </mat-button-toggle-group>
              <p>Alice, Maya, Noah and Olivia are enabled in order.</p>
            }
            <span class="field-label">Reply speed</span>
            <mat-button-toggle-group
              [value]="runtime.replyDelay()"
              aria-label="Reply speed"
              (change)="runtime.replyDelay.set($event.value)"
            >
              <mat-button-toggle [value]="0">Instant</mat-button-toggle>
              <mat-button-toggle [value]="800">Natural</mat-button-toggle>
              <mat-button-toggle [value]="2000">Slow</mat-button-toggle>
            </mat-button-toggle-group>
          </mat-expansion-panel>

          <mat-expansion-panel expanded>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Sample data</mat-panel-title
              ></mat-expansion-panel-header
            >
            <div class="field-row">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Data volume</mat-label>
                <input matInput type="number" min="0" [(ngModel)]="itemCount" />
              </mat-form-field>
              <button mat-flat-button type="button" (click)="applyDataCount()">
                Set
              </button>
              <button mat-button type="button" (click)="resetData()">
                Reset
              </button>
            </div>
            <span class="field-label">Source latency</span>
            <mat-button-toggle-group
              [value]="runtime.sourceLatency()"
              aria-label="Source latency"
              (change)="setSourceLatency($event.value)"
            >
              @for (delay of [0, 200, 1000, 5000]; track delay) {
                <mat-button-toggle [value]="delay">{{
                  delay < 1000 ? delay + 'ms' : delay / 1000 + 's'
                }}</mat-button-toggle>
              }
            </mat-button-toggle-group>
            <mat-slide-toggle
              [checked]="loadingPreview()"
              (change)="setLoadingPreview($event.checked)"
              >Preview loading state</mat-slide-toggle
            >
          </mat-expansion-panel>

          <mat-expansion-panel>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Message simulation</mat-panel-title
              ></mat-expansion-panel-header
            >
            <mat-slide-toggle
              [checked]="runtime.opponentInterleave()"
              (change)="toggleOpponentInterleave()"
              >Opponent interleave</mat-slide-toggle
            >
            <mat-slide-toggle
              [checked]="runtime.sendError()"
              (change)="toggleSendError()"
              >Mock send error</mat-slide-toggle
            >
            <span class="field-label">Send confirm delay</span>
            <mat-button-toggle-group
              class="two-column-options"
              [value]="runtime.confirmDelay()"
              aria-label="Send confirm delay"
              (change)="runtime.confirmDelay.set($event.value)"
            >
              @for (delay of [0, 300, 800, 2000]; track delay) {
                <mat-button-toggle [value]="delay"
                  >{{ delay }}ms</mat-button-toggle
                >
              }
            </mat-button-toggle-group>
            <span class="field-label">Push signal delay</span>
            <mat-button-toggle-group
              class="two-column-options"
              [value]="runtime.pushSignalDelay()"
              aria-label="Push signal delay"
              (change)="runtime.pushSignalDelay.set($event.value)"
            >
              @for (delay of [0, 500, 1500, 3000]; track delay) {
                <mat-button-toggle [value]="delay"
                  >{{ delay }}ms</mat-button-toggle
                >
              }
            </mat-button-toggle-group>
          </mat-expansion-panel>

          <mat-expansion-panel expanded>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Jump</mat-panel-title
              ></mat-expansion-panel-header
            >
            <div class="button-row">
              <button
                mat-stroked-button
                type="button"
                (click)="chatThread.scrollToTop()"
              >
                Top
              </button>
              <button
                mat-stroked-button
                type="button"
                (click)="chatThread.scrollToLatest()"
              >
                Latest
              </button>
            </div>
            <div class="field-row">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Message number</mat-label>
                <input matInput type="number" min="1" [(ngModel)]="jumpId" />
              </mat-form-field>
              <button mat-flat-button type="button" (click)="jump()">
                Jump
              </button>
            </div>
          </mat-expansion-panel>

          <mat-expansion-panel>
            <mat-expansion-panel-header
              ><mat-panel-title
                >Engine &amp; diagnostics</mat-panel-title
              ></mat-expansion-panel-header
            >
            <p>
              The preview uses the production message thread, virtual scroller,
              header, composer and overlays.
            </p>
            <mat-slide-toggle
              [checked]="!runtime.closeCheckpoint()"
              (change)="setCheckpoint(!$event.checked)"
              >Mount checkpoint</mat-slide-toggle
            >
            <span class="field-label">Viewport position</span>
            <p>{{ viewportInfo() }}</p>
            <button
              mat-stroked-button
              type="button"
              (click)="refreshViewportInfo()"
            >
              Refresh
            </button>
            <span class="field-label">Kernel params</span>
            <div class="kernel-grid">
              @for (field of kernelFields; track field.key) {
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>{{ field.label }}</mat-label>
                  <input
                    matInput
                    type="number"
                    [(ngModel)]="kernelConfig[field.key]"
                  />
                </mat-form-field>
              }
            </div>
            <div class="button-row engine-actions">
              <button
                mat-flat-button
                type="button"
                (click)="applyKernelConfig()"
              >
                Apply and reload
              </button>
            </div>
          </mat-expansion-panel>
        </mat-accordion>
      </aside>
    </main>
  `,
  styleUrl: './playground-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundShellComponent {
  private readonly conversations = inject(PlaygroundConversationList);
  readonly conversation = computed(
    () => this.conversations.current() ?? DEMO_CONVERSATION,
  );
  readonly runtime = inject(PlaygroundMessageThreadAdapter);
  readonly nav = inject(NavStateMachineService);
  readonly asidePanel = computed(() => this.nav.asideTop()?.panel);
  readonly callState = inject(PlaygroundCallState);
  readonly i18n = inject(TranslocoService);
  readonly theme = inject(ThemeService);
  readonly panelOpen = signal(false);
  readonly viewportInfo = signal('Refresh to inspect the current window.');
  readonly loadingPreview = signal(false);
  readonly thread = viewChild.required(MessageThreadComponent);
  readonly settingsButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('settingsButton');
  itemCount = this.runtime.itemCount();
  jumpId = 1;
  kernelConfig = { ...this.runtime.config() };
  readonly kernelFields: ReadonlyArray<{
    key: KernelFieldKey;
    label: string;
  }> = [
    { key: 'initBatch', label: 'initBatch' },
    { key: 'mountItem', label: 'mountItem' },
    { key: 'thresholdFloor', label: 'thresholdFloor' },
    { key: 'vhExtra', label: 'vhExtra' },
    { key: 'edge', label: 'edge' },
  ];
  private buttonDragging = false;
  private buttonMoved = false;
  private buttonStartX = 0;
  private buttonStartY = 0;
  private buttonStartLeft = 0;
  private buttonStartTop = 0;

  constructor() {
    this.conversations.setConversation(DEMO_GROUP_CONVERSATION);
    // Alice is already in the group; Liam remains available in the invite-friends picker.
    this.conversations.setRelatedConversations([
      DEMO_CONVERSATION,
      DEMO_INVITABLE_FRIEND,
    ]);
    effect(() => {
      if (this.nav.chatThreadId() === DEMO_CONVERSATION.threadId)
        this.conversations.setConversation(DEMO_CONVERSATION);
    });
  }

  onSettingsButtonDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const button = this.settingsButton().nativeElement;
    event.preventDefault();
    const rect = button.getBoundingClientRect();
    this.buttonStartX = event.clientX;
    this.buttonStartY = event.clientY;
    this.buttonStartLeft = rect.left;
    this.buttonStartTop = rect.top;
    this.buttonMoved = false;
    this.buttonDragging = true;
    button.style.left = `${rect.left}px`;
    button.style.top = `${rect.top}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
    button.classList.add('dragging');
    window.addEventListener('pointermove', this.onSettingsButtonMove);
    window.addEventListener('pointerup', this.onSettingsButtonUp);
  }

  private readonly onSettingsButtonMove = (event: PointerEvent): void => {
    if (!this.buttonDragging) return;
    const dx = event.clientX - this.buttonStartX;
    const dy = event.clientY - this.buttonStartY;
    if (!this.buttonMoved && Math.hypot(dx, dy) < 5) return;
    this.buttonMoved = true;
    const button = this.settingsButton().nativeElement;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - button.offsetWidth - 8,
        this.buttonStartLeft + dx,
      ),
    );
    const top = Math.max(
      8,
      Math.min(
        window.innerHeight - button.offsetHeight - 8,
        this.buttonStartTop + dy,
      ),
    );
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
  };

  private readonly onSettingsButtonUp = (event: PointerEvent): void => {
    window.removeEventListener('pointermove', this.onSettingsButtonMove);
    window.removeEventListener('pointerup', this.onSettingsButtonUp);
    const button = this.settingsButton().nativeElement;
    button.classList.remove('dragging');
    const moved = this.buttonMoved;
    this.buttonDragging = false;
    this.buttonMoved = false;
    if (!moved) {
      this.panelOpen.update((open) => !open);
      return;
    }
    button.style.left = `${event.clientX < window.innerWidth / 2 ? 16 : window.innerWidth - button.offsetWidth - 16}px`;
  };

  applyDataCount(): void {
    this.runtime.itemCount.set(Math.max(0, Math.trunc(this.itemCount)));
    this.reload();
  }

  resetData(): void {
    this.itemCount = 0;
    this.runtime.itemCount.set(0);
    this.reload();
  }

  setLoadingPreview(preview: boolean): void {
    this.loadingPreview.set(preview);
    this.runtime.sourceLatency.set(preview ? 5000 : 200);
    this.reload();
  }

  setSourceLatency(delay: number): void {
    this.runtime.sourceLatency.set(delay);
    this.reload();
  }

  toggleSendError(): void {
    this.runtime.sendError.update((value) => !value);
  }

  toggleOpponentInterleave(): void {
    this.runtime.opponentInterleave.update((value) => !value);
  }

  setCheckpoint(closed: boolean): void {
    this.runtime.closeCheckpoint.set(closed);
    this.reload();
  }

  refreshViewportInfo(): void {
    const info = this.thread().scrollInfo();
    this.viewportInfo.set(
      info
        ? `oldest ${info.oldestId ?? '—'} · newest ${info.newestId ?? '—'} · top ${info.noOlder ? 'boundary' : 'open'} · bottom ${info.noNewer ? 'boundary' : 'open'}`
        : 'The message window is not ready.',
    );
  }

  applyKernelConfig(): void {
    this.runtime.config.set({
      ...this.kernelConfig,
      deferInitFill: true,
    });
    this.reload();
  }

  reload(): void {
    this.thread().reload();
  }

  setConversationType(type: 'P2P' | 'GROUP'): void {
    this.nav.closeAside();
    this.conversations.setConversation(
      type === 'GROUP' ? DEMO_GROUP_CONVERSATION : DEMO_CONVERSATION,
    );
  }

  setGroupSenderCount(count: number): void {
    this.runtime.groupSenderCount.set(count);
    this.reload();
  }

  setCallResponse(response: PlaygroundCallResponse): void {
    this.callState.opponentResponse.set(response);
  }

  setMuted(muted: boolean): void {
    const threadId = this.conversation().threadId;
    this.runtime.setMuted({ threadId, muted }).subscribe((result) => {
      if (result.code === 0)
        this.conversations.applyThreadMeta(threadId, { muted });
    });
  }

  setBlocked(blocked: boolean): void {
    const threadId = this.conversation().threadId;
    this.runtime.setBlocked({ threadId, blocked }).subscribe((result) => {
      if (result.code === 0)
        this.conversations.applyThreadMeta(threadId, { blocked });
    });
  }

  jump(): void {
    void this.thread().jumpToMessage(Math.max(1, Math.trunc(this.jumpId)));
  }
}
