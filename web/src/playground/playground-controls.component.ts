import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
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
import {
  PlaygroundCallState,
  type PlaygroundCallResponse,
} from './playground-call.mock';
import { PlaygroundConversationList } from './playground-conversation-list.mock';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';

type KernelFieldKey =
  | 'initBatch'
  | 'mountItem'
  | 'thresholdFloor'
  | 'vhExtra'
  | 'edge';

/** Floating scenario controls layered over the production home shell. */
@Component({
  selector: 'app-playground-controls',
  imports: [
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
  ],
  template: `
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
          d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
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
          <h2>UI Playground</h2>
          <p>Production home shell · mock transport</p>
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
            ><mat-panel-title
              >Conversation</mat-panel-title
            ></mat-expansion-panel-header
          >
          @if (conversationType() === 'P2P') {
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
              (change)="runtime.groupSenderCount.set($event.value)"
            >
              @for (count of [2, 3, 4]; track count) {
                <mat-button-toggle [value]="count">{{
                  count
                }}</mat-button-toggle>
              }
            </mat-button-toggle-group>
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
          <span class="field-label">Call response</span>
          <mat-button-toggle-group
            class="two-column-options"
            [value]="callState.opponentResponse()"
            aria-label="Call response"
            (change)="setCallResponse($event.value)"
          >
            <mat-button-toggle value="decline">Decline</mat-button-toggle>
            <mat-button-toggle value="busy">Busy</mat-button-toggle>
            <mat-button-toggle value="no-answer">No answer</mat-button-toggle>
            <mat-button-toggle value="accept">Accept</mat-button-toggle>
          </mat-button-toggle-group>
        </mat-expansion-panel>

        <mat-expansion-panel>
          <mat-expansion-panel-header
            ><mat-panel-title
              >Message simulation</mat-panel-title
            ></mat-expansion-panel-header
          >
          <mat-slide-toggle
            [checked]="runtime.opponentInterleave()"
            (change)="runtime.opponentInterleave.set($event.checked)"
            >Opponent interleave</mat-slide-toggle
          >
          <mat-slide-toggle
            [checked]="runtime.sendError()"
            (change)="runtime.sendError.set($event.checked)"
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

        <mat-expansion-panel>
          <mat-expansion-panel-header
            ><mat-panel-title
              >New thread defaults</mat-panel-title
            ></mat-expansion-panel-header
          >
          <p>
            These values apply when the production chat pane creates a fresh
            mock source.
          </p>
          <div class="field-row">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Data volume</mat-label>
              <input matInput type="number" min="0" [(ngModel)]="itemCount" />
            </mat-form-field>
            <button mat-flat-button type="button" (click)="applyDataCount()">
              Apply
            </button>
          </div>
          <span class="field-label">Source latency</span>
          <mat-button-toggle-group
            [value]="runtime.sourceLatency()"
            aria-label="Source latency"
            (change)="runtime.sourceLatency.set($event.value)"
          >
            @for (delay of [0, 200, 1000, 5000]; track delay) {
              <mat-button-toggle [value]="delay">{{
                delay < 1000 ? delay + 'ms' : delay / 1000 + 's'
              }}</mat-button-toggle>
            }
          </mat-button-toggle-group>
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
          <button mat-flat-button type="button" (click)="applyKernelConfig()">
            Apply defaults
          </button>
        </mat-expansion-panel>

        <mat-expansion-panel>
          <mat-expansion-panel-header>
            <mat-panel-title>Page previews</mat-panel-title>
          </mat-expansion-panel-header>
          <p>Quickly preview error pages & standalone views:</p>
          <div
            style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;"
          >
            <a
              mat-stroked-button
              href="#/effects"
              (click)="panelOpen.set(false)"
            >
              Visual Effects & Error Pages Showcase
            </a>
            <a mat-stroked-button href="#/404" (click)="panelOpen.set(false)">
              404 (Page Not Found)
            </a>
            <a mat-stroked-button href="#/403" (click)="panelOpen.set(false)">
              403 (Access Denied)
            </a>
            <a
              mat-stroked-button
              href="#/deploy"
              (click)="panelOpen.set(false)"
            >
              Deploy SOMS
            </a>
          </div>
        </mat-expansion-panel>
      </mat-accordion>
    </aside>
  `,
  styleUrl: './playground-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundControlsComponent {
  readonly conversations = inject(PlaygroundConversationList);
  readonly runtime = inject(PlaygroundMessageThreadAdapter);
  readonly callState = inject(PlaygroundCallState);
  readonly panelOpen = signal(false);
  readonly settingsButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('settingsButton');
  readonly conversationType = () =>
    this.conversations.current()?.type ?? 'GROUP';
  itemCount = this.runtime.itemCount();
  kernelConfig = { ...this.runtime.config() };
  readonly kernelFields: ReadonlyArray<{ key: KernelFieldKey; label: string }> =
    [
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

  setCallResponse(response: PlaygroundCallResponse): void {
    this.callState.opponentResponse.set(response);
  }

  applyDataCount(): void {
    this.runtime.itemCount.set(Math.max(0, Math.trunc(this.itemCount)));
  }

  applyKernelConfig(): void {
    this.runtime.config.set({ ...this.kernelConfig, deferInitFill: true });
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
    button.style.left = `${Math.max(8, Math.min(window.innerWidth - button.offsetWidth - 8, this.buttonStartLeft + dx))}px`;
    button.style.top = `${Math.max(8, Math.min(window.innerHeight - button.offsetHeight - 8, this.buttonStartTop + dy))}px`;
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
}
