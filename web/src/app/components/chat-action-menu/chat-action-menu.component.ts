import {
  Component,
  EventEmitter,
  Input,
  Output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ConnectedPosition, CdkOverlayOrigin, OverlayModule } from '@angular/cdk/overlay';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent } from '../icon/icon.component';
import { AppIconType } from '../icon/model';

/**
 * One entry in the chat action menu. `divider` renders a separator (not selectable). `action` renders
 * an icon + label row; `danger` styles it in --app-danger (destructive actions). The two-tap confirm
 * flow is driven entirely by the PARENT swapping the `entries` list — this component stays
 * presentational (no business logic, no confirm state of its own).
 */
export type ChatMenuEntry =
  | { kind: 'divider' }
  | {
      kind: 'action';
      key: string;
      labelKey: string;
      icon?: AppIconType;
      danger?: boolean;
    };

/**
 * Small contextual action menu anchored to the chat header MORE button via a CDK connected overlay.
 *
 * The overlay is attached at the DOCUMENT root (CDK's default), so it escapes the A/B double-buffered
 * pane's stacking context entirely and paints above every shell/pane tier (the reason a plain
 * absolute-positioned panel inside the header is NOT used — the chat pane layers resolve at the root
 * stacking context and would occlude an in-flow dropdown). Backdrop click + ESC close it. Integer-px
 * row heights keep the rendered offsetHeight whole (the project's CSS integer-pixel rule).
 */
@Component({
  selector: 'app-chat-action-menu',
  imports: [OverlayModule, TranslocoModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOpen]="open"
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayHasBackdrop]="true"
      [cdkConnectedOverlayBackdropClass]="'cdk-overlay-transparent-backdrop'"
      [cdkConnectedOverlayDisposeOnNavigation]="true"
      (backdropClick)="closed.emit()"
      (detach)="closed.emit()"
      (overlayKeydown)="onOverlayKeydown($event)"
    >
      <div class="chat-menu" role="menu" (click)="$event.stopPropagation()">
        @for (entry of entries; track entry.kind === 'divider' ? 'd' + $index : entry.key) {
          @if (entry.kind === 'divider') {
            <div class="chat-menu-divider" aria-hidden="true"></div>
          } @else {
            <button
              type="button"
              class="chat-menu-item"
              [class.danger]="entry.danger"
              role="menuitem"
              (click)="select.emit(entry.key)"
            >
              @if (entry.icon) {
                <app-icon class="chat-menu-icon" [type]="entry.icon" [style]="{ width: '18px', height: '18px' }"></app-icon>
              }
              <span class="chat-menu-label">{{ entry.labelKey | transloco }}</span>
            </button>
          }
        }
      </div>
    </ng-template>
  `,
  styles: [`
    .chat-menu {
      /* Root-level overlay (CDK attaches at document body) → paints above all shell/pane tiers. */
      min-width: 208px;
      max-width: 280px;
      background: var(--app-surface);
      border: 1px solid var(--app-border);
      border-radius: var(--app-radius-md, 10px);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
      overflow: hidden;
      padding: 6px 0;
    }
    .chat-menu-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      height: 40px;
      padding: 0 16px;
      border: none;
      background: transparent;
      color: var(--app-text);
      text-align: left;
      cursor: pointer;
      font-size: 14px;
      line-height: 20px; /* integer line-height — keeps the 40px row a whole pixel */
      box-sizing: border-box;
    }
    .chat-menu-item:hover { background: var(--app-hover); }
    .chat-menu-item:focus-visible { outline: 2px solid var(--app-brand); outline-offset: -2px; }
    .chat-menu-item.danger { color: var(--app-danger, #d33); }
    .chat-menu-icon { display: inline-flex; flex: 0 0 18px; }
    .chat-menu-label { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-menu-divider {
      height: 1px;
      margin: 4px 0;
      background: var(--app-border);
    }
  `],
})
export class ChatActionMenuComponent {
  /** The entries to render. Swapping this list drives the two-tap confirm flow (parent-owned). */
  @Input({ required: true }) entries!: ChatMenuEntry[];
  /** The CDK overlay origin (the MORE button, which carries `cdkOverlayOrigin`). */
  @Input({ required: true }) origin!: CdkOverlayOrigin;
  /** Whether the overlay is open. */
  @Input() open = false;

  @Output() readonly select = new EventEmitter<string>();
  @Output() readonly closed = new EventEmitter<void>();

  /** ESC closes the menu. A CDK connected overlay with a backdrop does NOT auto-close on Escape,
   *  so the doc'd "ESC close it" behavior must be wired explicitly. Route-change close is handled
   *  separately by cdkConnectedOverlayDisposeOnNavigation (which fires detach → closed above). */
  onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.closed.emit();
  }

  /** Anchored below the origin's right edge by default. A bottom composer can supply an above-first list. */
  @Input() positions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top' },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom' },
  ];
}
