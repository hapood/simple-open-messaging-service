import {
  afterNextRender,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { CallEventService } from '../../services/call-event.service';
import { CallAdapterService } from '../../services/call-adapter';
import { CallRingtoneService } from '../../services/call-ringtone.service';
import { CallPresentationService } from '../../services/call-presentation.service';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { AppIconType, IconComponent } from '../icon/icon.component';

/**
 * The 1:1 call UI — a fullscreen overlay mounted at the app root (AppComponent), shown whenever a call is
 * active (CallEventService.callState.phase !== 'idle'). It reads the merged call state signal and drives the
 * selected media owner through CallAdapterService: native Kotlin on Android, WebRTC in the renderer on
 * browser/desktop. The component itself remains presentation-only.
 *
 * AUDIO layout: centered avatar/name + status + Mute + End.
 * VIDEO layout (callType === 'VIDEO'): the `.call-screen` is full-bleed; browser/desktop render into its
 * `<video>` elements, while Android positions native SurfaceViewRenderers over the same remote/self geometry.
 * The controls gain camera-switch + camera on/off actions.
 *
 * Native video surfaces are positioned via `adapter.setVideoRect`; renderer media binds through
 * `adapter.setVideoElements`. Both use the same visual slots, so the UI remains platform-neutral.
 *
 * Terminal phases are folded to 'idle' by CallEventService, so the overlay dismisses on hang-up / decline /
 * peer-end; the terminal CALL bubble in the thread is the user-visible record.
 *
 * Rendered at z-index 1200 (above the lightbox tier at 1100 — a call is the topmost surface). The status label
 * is bilingual via the `call` i18n namespace; the remaining template labels (buttons) are still English pending
 * a fuller i18n pass (per the UI-text convention).
 */
@Component({
  selector: 'app-call-screen',
  standalone: true,
  template: `
    @if (snap().phase !== 'idle') {
      <div
        class="call-screen"
        [class.video]="isVideo()"
        [class.swapped]="snap().swapped"
        [class.incoming]="snap().phase === 'incoming'"
        [class.controls-hidden]="!controlsVisible()"
        [class.pip]="inPip()"
        (pointerdown)="onScreenTap()"
        (mousemove)="onScreenMouseMove()"
      >
        <button
          class="minimize"
          type="button"
          (pointerdown)="$event.stopPropagation()"
          (click)="minimize(); $event.stopPropagation()"
          [attr.aria-label]="'call.minimize' | transloco"
        >
          <app-icon
            class="minimize-icon"
            [type]="AppIconType.CHEVRON_DOWN"
            [style]="miniIconSize"
          ></app-icon>
        </button>
        @if (isVideo()) {
          <video
            class="remote-video"
            autoplay
            playsinline
            (loadeddata)="onRemoteVideoReady()"
            (playing)="onRemoteVideoReady()"
            #remoteVideo
          ></video>
          @if (!snap().swapped && showRemotePlaceholder()) {
            <div class="remote-camera-off">
              <div class="remote-avatar">
                <app-user-avatar
                  [type]="UserAvatarType.OTHER"
                  [name]="snap().peerName || '?'"
                  [identityId]="snap().peerUserId"
                  [src]="snap().peerAvatar"
                ></app-user-avatar>
              </div>
              <span>
                @if (waitingForRemoteVideo()) {
                  {{ 'call.waitingForVideo' | transloco }}
                } @else {
                  {{
                    'call.peerCameraOff'
                      | transloco: { name: snap().peerName || '…' }
                  }}
                }
              </span>
            </div>
          }
          <!-- The self-view hole: native renders the LOCAL camera here (positioned top-right, the
               mainstream-app "picture-in-picture" self preview). Transparent until native attaches. -->
          <div
            class="self-view"
            [class.off]="
              snap().swapped ? showRemotePlaceholder() : !snap().cameraEnabled
            "
            [style.transform]="selfTransform()"
            (pointerdown)="onSelfPointerDown($event)"
            (pointermove)="onSelfPointerMove($event)"
            (pointerup)="onSelfPointerUp($event)"
            (pointercancel)="onSelfPointerUp($event)"
            #selfHole
          >
            <video autoplay muted playsinline #selfVideo></video>
            @if (snap().swapped && showRemotePlaceholder()) {
              <div class="pip-peer-off">
                <app-user-avatar
                  [type]="UserAvatarType.OTHER"
                  [name]="snap().peerName || '?'"
                  [identityId]="snap().peerUserId"
                  [src]="snap().peerAvatar"
                ></app-user-avatar>
              </div>
            } @else if (!snap().swapped && !snap().cameraEnabled) {
              <app-icon
                class="self-off-icon"
                [type]="AppIconType.VIDEO_OFF"
                [style]="actionIconSize"
              ></app-icon>
              <span class="self-off">{{ 'call.cameraOff' | transloco }}</span>
            }
          </div>
          @if (snap().swapped && !snap().cameraEnabled) {
            <div class="remote-camera-off local-camera-off">
              <div class="remote-avatar">
                <app-user-avatar [type]="UserAvatarType.SELF"></app-user-avatar>
              </div>
              <span>{{ 'call.cameraOff' | transloco }}</span>
            </div>
          }
        }

        <div class="top-bar">
          <div class="call-kind">
            {{ (isVideo() ? 'call.videoCall' : 'call.audioCall') | transloco }}
          </div>
          <div class="name">{{ snap().peerName || '…' }}</div>
          <div
            class="status"
            role="status"
            aria-live="polite"
            [class.reconnecting]="snap().phase === 'reconnecting'"
          >
            {{ statusLabel() }}
          </div>
          @if (
            snap().phase === 'connected' || snap().phase === 'reconnecting'
          ) {
            <div class="timer">{{ timer() }}</div>
          }
        </div>

        @if (!isVideo()) {
          <!-- AUDIO: centered peer avatar. VIDEO: hidden (the avatar would sit behind the full-bleed remote
               video). UserAvatarComponent reads the IDB cache (no /uploads fetch on every mount); its
               initial-letter fallback covers a no-avatar / cache-miss peer. -->
          <div class="peer">
            <div class="avatar">
              <app-user-avatar
                [type]="UserAvatarType.OTHER"
                [name]="snap().peerName || '?'"
                [identityId]="snap().peerUserId"
                [src]="snap().peerAvatar"
              ></app-user-avatar>
            </div>
          </div>
        }

        <div class="controls">
          @switch (snap().phase) {
            @case ('incoming') {
              <button
                class="call-action decline"
                type="button"
                (click)="decline()"
                [attr.aria-label]="'call.decline' | transloco"
              >
                <span class="action-icon">
                  <app-icon
                    [type]="AppIconType.PHONE_END"
                    [style]="actionIconSize"
                  ></app-icon>
                </span>
                <span class="action-label">{{
                  'call.decline' | transloco
                }}</span>
              </button>
              <button
                class="call-action accept"
                type="button"
                (click)="accept()"
                [attr.aria-label]="'call.accept' | transloco"
              >
                <span class="action-icon">
                  <app-icon
                    [type]="AppIconType.PHONE"
                    [style]="actionIconSize"
                  ></app-icon>
                </span>
                <span class="action-label">{{
                  'call.accept' | transloco
                }}</span>
              </button>
            }
            @case ('ended') {}
            @default {
              <button
                class="call-action mute"
                [class.on]="snap().muted"
                [attr.aria-pressed]="snap().muted"
                type="button"
                (click)="toggleMute()"
                [attr.aria-label]="
                  (snap().muted ? 'call.unmute' : 'call.mute') | transloco
                "
              >
                <span class="action-icon">
                  <app-icon
                    [type]="
                      snap().muted ? AppIconType.MIC_OFF : AppIconType.MIC
                    "
                    [style]="actionIconSize"
                  ></app-icon>
                </span>
                <span class="action-label">{{
                  (snap().muted ? 'call.unmute' : 'call.mute') | transloco
                }}</span>
              </button>
              @if (
                !isVideo() &&
                canUpgradeVideo() &&
                adapter.videoSupported !== false
              ) {
                <button
                  class="call-action upgrade"
                  type="button"
                  [disabled]="snap().videoUpgradeState === 'upgrading'"
                  (click)="upgradeToVideo()"
                  [attr.aria-label]="
                    (snap().videoUpgradeState === 'upgrading'
                      ? 'call.startingVideo'
                      : 'call.startVideo'
                    ) | transloco
                  "
                >
                  <span class="action-icon">
                    @if (snap().videoUpgradeState === 'upgrading') {
                      <span class="upgrade-spinner" aria-hidden="true"></span>
                    } @else {
                      <app-icon
                        [type]="AppIconType.VIDEO"
                        [style]="actionIconSize"
                      ></app-icon>
                    }
                  </span>
                  <span class="action-label">
                    {{
                      (snap().videoUpgradeState === 'upgrading'
                        ? 'call.startingVideo'
                        : 'call.startVideo'
                      ) | transloco
                    }}
                  </span>
                </button>
              }
              @if (isVideo()) {
                <button
                  class="call-action cam"
                  [class.on]="!snap().cameraEnabled"
                  [attr.aria-pressed]="!snap().cameraEnabled"
                  type="button"
                  (click)="toggleCamera()"
                  [attr.aria-label]="
                    (snap().cameraEnabled ? 'call.cameraOff' : 'call.cameraOn')
                      | transloco
                  "
                >
                  <span class="action-icon">
                    <app-icon
                      [type]="
                        snap().cameraEnabled
                          ? AppIconType.VIDEO
                          : AppIconType.VIDEO_OFF
                      "
                      [style]="actionIconSize"
                    ></app-icon>
                  </span>
                  <span class="action-label">{{
                    (snap().cameraEnabled ? 'call.cameraOff' : 'call.cameraOn')
                      | transloco
                  }}</span>
                </button>
                <button
                  class="call-action switch"
                  type="button"
                  [disabled]="!snap().cameraEnabled"
                  (click)="switchCamera()"
                  [attr.aria-label]="'call.switchCamera' | transloco"
                >
                  <span class="action-icon">
                    <app-icon
                      [type]="AppIconType.CAMERA_SWITCH"
                      [style]="actionIconSize"
                    ></app-icon>
                  </span>
                  <span class="action-label">{{
                    'call.switchCamera' | transloco
                  }}</span>
                </button>
              }
              <button
                class="call-action end"
                type="button"
                (click)="hangUp()"
                [attr.aria-label]="'call.end' | transloco"
              >
                <span class="action-icon">
                  <app-icon
                    [type]="AppIconType.PHONE_END"
                    [style]="actionIconSize"
                  ></app-icon>
                </span>
                <span class="action-label">{{ 'call.end' | transloco }}</span>
              </button>
            }
          }
        </div>
      </div>
    }
  `,
  imports: [TranslocoModule, UserAvatarComponent, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .call-screen {
        position: fixed;
        inset: 0;
        z-index: 1200; /* above the lightbox tier (1100) — a call is the topmost surface */
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 28px;
        padding: calc(24px + var(--soms-safe-top, 0px)) 24px
          calc(32px + var(--soms-safe-bottom, 0px));
        box-sizing: border-box;
        background: radial-gradient(
            circle at 50% 24%,
            color-mix(in srgb, var(--app-brand) 18%, transparent),
            transparent 38%
          ),
          linear-gradient(160deg, #171a21 0%, #111216 58%, #0d0e12 100%);
        color: #fff;
        overflow: hidden;
      }
      .minimize {
        position: fixed;
        top: calc(12px + var(--soms-safe-top, 0px));
        left: 12px;
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 22px;
        color: #fff;
        background: rgba(0, 0, 0, 0.38);
        z-index: 6;
        pointer-events: auto;
      }
      .minimize-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
        transform: rotate(180deg);
      }
      /* Incoming calls get a little more visual focus without becoming a separate design language: the
         brand glow and surface geometry reuse the application's semantic tokens, while the dark base keeps
         the lock-screen presentation calm and readable. */
      .call-screen.incoming::before,
      .call-screen.incoming::after {
        content: '';
        position: absolute;
        border-radius: 50%;
        pointer-events: none;
        filter: blur(2px);
      }
      .call-screen.incoming::before {
        width: min(76vw, 520px);
        aspect-ratio: 1;
        top: -34%;
        background: color-mix(in srgb, var(--app-brand) 12%, transparent);
      }
      .call-screen.incoming::after {
        width: 240px;
        height: 240px;
        bottom: -150px;
        right: -90px;
        background: color-mix(
          in srgb,
          var(--app-brand-accent) 10%,
          transparent
        );
      }
      /* VIDEO: full-bleed + transparent so the native remote SurfaceViewRenderer (a sibling view BEHIND the
         WebView, via the barcode-scanner overlay technique) shows through. The native side sets the WebView
         background TRANSPARENT while a video call is active. */
      .call-screen.video {
        background: transparent;
        justify-content: flex-end;
        padding-bottom: calc(32px + var(--soms-safe-bottom, 0px));
      }
      .call-screen.video::before,
      .call-screen.video::after {
        display: none;
      }
      /* The chrome (name/status + controls) fades in/out on auto-hide. opacity only — no layout shift, so the
         native video-surface rects never need re-reporting (a hidden control keeps its space, just invisible). */
      .call-screen.video .top-bar,
      .call-screen.video .controls {
        transition: opacity 220ms ease;
      }
      .call-screen.controls-hidden .top-bar,
      .call-screen.controls-hidden .controls {
        opacity: 0;
        pointer-events: none; /* a hidden control can't be tapped; a tap anywhere on the screen reveals them */
      }
      /* PiP: only the native remote video should fill the small window. Hide the chrome + the self-view (the
         self surface is also detached natively via reportVideoRects passing self=null). display:none — the
         PiP window is tiny, the chrome would be unreadable clutter; the remote video is the whole point. */
      .call-screen.pip .top-bar,
      .call-screen.pip .controls,
      .call-screen.pip .self-view {
        display: none;
      }
      .self-view {
        position: absolute;
        left: 0;
        top: 0;
        width: 120px;
        height: 160px;
        will-change: transform;
        /* touch-action:none lets the pointer drag own the gesture (the browser won't steal it as scroll/zoom). */
        touch-action: none;
        /* No frame: this div is a transparent positioning anchor + the drag/tap target. The native self
           SurfaceViewRenderer (a media-overlay sibling BEHIND this hole) draws the actual video, positioned
           over it via reportVideoRects. Position (left/top) is bound to selfLeft()/selfTop() (draggable). */
        background: transparent;
      }
      .self-view.off {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        /* Camera off → the native track is disabled (frozen/black surface); an opaque bg so the label reads. */
        background: rgba(0, 0, 0, 0.6);
      }
      .self-off-icon {
        margin-bottom: 4px;
        opacity: 0.82;
      }
      .self-off {
        font-size: 12px;
        line-height: 16px;
        opacity: 0.8;
      }
      .pip-peer-off {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #292b31;
      }
      .remote-camera-off {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 20px;
        background: radial-gradient(
            circle at 50% 38%,
            rgba(255, 255, 255, 0.09),
            transparent 28%
          ),
          #111216;
        color: rgba(255, 255, 255, 0.78);
        font-size: 14px;
        line-height: 20px;
      }

      .remote-video,
      .self-view video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .remote-video {
        position: absolute;
        inset: 0;
        z-index: 0;
      }

      .self-view video {
        display: block;
      }
      .remote-avatar {
        width: 112px;
        height: 112px;
        overflow: hidden;
        border-radius: 28px;
        box-shadow: 0 16px 44px rgba(0, 0, 0, 0.32);
      }
      .top-bar {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        text-align: center;
        text-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);
      }
      .call-kind {
        margin-bottom: 4px;
        font-size: 12px;
        line-height: 16px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.62;
      }
      .peer {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .avatar {
        width: 128px;
        height: 128px;
        border: 3px solid rgba(255, 255, 255, 0.16);
        border-radius: 20%;
        overflow: hidden;
        box-shadow:
          0 14px 42px rgba(0, 0, 0, 0.32),
          0 0 0 8px rgba(255, 255, 255, 0.035);
      }
      .name {
        max-width: min(360px, calc(100vw - 48px));
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 24px;
        line-height: 32px;
        font-weight: 600;
      }
      .status {
        font-size: 15px;
        line-height: 20px;
        opacity: 0.8;
        min-height: 20px;
      }
      /* Reconnecting is expected to recover (GATHER_CONTINUALLY + the caller's ICE restart), so a calm amber
         pulse — not alarm-red. opacity keyframes only (no height contribution → integer-pixel-safe). */
      .status.reconnecting {
        color: #ffb300;
        animation: soms-call-pulse 1.4s ease-in-out infinite;
      }
      @keyframes soms-call-pulse {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }
      .timer {
        font-size: 18px;
        line-height: 24px;
        font-variant-numeric: tabular-nums;
      }
      .controls {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-start;
        gap: clamp(12px, 4vw, 24px);
        flex-wrap: wrap;
        justify-content: center;
        width: min(100%, 440px);
        padding: 0 16px;
        box-sizing: border-box;
      }
      .call-screen.incoming .controls {
        gap: clamp(40px, 15vw, 76px);
        width: min(100%, 360px);
        padding: 0 20px;
      }
      .call-screen.incoming .action-icon {
        width: 58px;
        height: 58px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
      }
      .call-action {
        width: 72px;
        min-height: 76px;
        padding: 0;
        border: none;
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        background: transparent;
        color: #fff;
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .call-action:disabled {
        cursor: default;
        opacity: 0.64;
      }
      .action-icon {
        width: 52px;
        height: 52px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.14);
        transition:
          transform 120ms ease,
          background-color 120ms ease;
      }
      .action-icon app-icon,
      .self-off-icon {
        display: inline-flex;
      }
      .action-label {
        max-width: 76px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        line-height: 16px;
        opacity: 0.84;
      }
      @media (hover: hover) and (pointer: fine) {
        .call-action:hover .action-icon {
          background: rgba(255, 255, 255, 0.22);
        }
      }
      .call-action:active .action-icon {
        transform: scale(0.94);
      }
      .call-action:focus-visible {
        outline: none;
      }
      .call-action:focus-visible .action-icon {
        outline: 2px solid #fff;
        outline-offset: 3px;
      }
      .accept .action-icon {
        background: var(--app-success, #16a34a);
      }
      .decline .action-icon,
      .end .action-icon {
        background: var(--app-danger, #dc2626);
      }
      .decline:active .action-icon,
      .end:active .action-icon {
        background: #b91c1c;
      }
      .mute.on .action-icon,
      .cam.on .action-icon {
        background: #fff;
        color: #16171b;
      }
      .upgrade-spinner {
        width: 20px;
        height: 20px;
        box-sizing: border-box;
        border: 2px solid rgba(255, 255, 255, 0.32);
        border-top-color: #fff;
        border-radius: 50%;
        animation: soms-call-spin 700ms linear infinite;
      }
      @keyframes soms-call-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (max-width: 359px) {
        .controls {
          gap: 8px;
          padding-inline: 8px;
        }
        .call-action {
          width: 64px;
        }
      }
      @media (max-height: 620px) {
        .call-screen {
          gap: 18px;
        }
        .avatar {
          width: 104px;
          height: 104px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .call-screen.video .top-bar,
        .call-screen.video .controls,
        .action-icon {
          transition: none;
        }
        .status.reconnecting {
          animation: none;
        }
        .upgrade-spinner {
          animation: none;
        }
      }
    `,
  ],
})
export class CallScreenComponent implements OnDestroy {
  readonly events = inject(CallEventService);
  readonly adapter = inject(CallAdapterService);
  private readonly transloco = inject(TranslocoService);
  private readonly ringtone = inject(CallRingtoneService);
  readonly presentation = inject(CallPresentationService);
  readonly miniIconSize = { width: '22px', height: '22px' };

  readonly snap = computed(() => this.events.callState());

  /** A 1s ticking clock so the connected timer updates; read by `timer()`. Cleared in ngOnDestroy. */
  private readonly now = signal(Date.now());
  private readonly timerHandle = setInterval(
    () => this.now.set(Date.now()),
    1000,
  );

  /** Whether the top-bar + controls are shown. In a connected VIDEO call they auto-hide ~3s after the last
   *  interaction for an immersive view (the native remote video fills the screen behind the transparent chrome);
   *  any tap on the screen reveals them again. Always visible otherwise (ringing / connecting / reconnecting /
   *  audio — the user must be able to act). */
  readonly controlsVisible = signal(true);
  readonly remoteVideoReady = signal(false);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly HIDE_DELAY_MS = 3000;

  /** True while the activity is in PiP (native pushes via __SOMS_PIP__). The chrome + self-view hide so only
   *  the remote video shows in the PiP window; the self surface detaches (reportVideoRects passes self=null). */
  readonly inPip = signal(false);

  /** Self-view PiP size (CSS px) — matches the .self-view width/height; used to clamp the drag. */
  private static readonly SELF_W = 120;
  private static readonly SELF_H = 160;
  /** Self-view position (CSS px, viewport-relative) — draggable; the native surface follows via reportVideoRects.
   *  Seeded top-right; clamped to the viewport on drag + resize. */
  readonly selfLeft = signal(
    typeof window !== 'undefined'
      ? window.innerWidth - CallScreenComponent.SELF_W - 16
      : 0,
  );
  readonly selfTop = signal(64);
  /** Compositor-only web hit-frame movement. The native video surface follows through the translation bridge. */
  readonly selfTransform = computed(
    () => `translate3d(${this.selfLeft()}px, ${this.selfTop()}px, 0)`,
  );
  private dragging = false;
  private dragOrigin = { px: 0, py: 0, left: 0, top: 0 };
  /** rAF coalescing flag so a drag burst fires at most one native setVideoRect per animation frame. */
  private rectReportPending = false;
  private lastVideoCallSid: string | null = null;

  /** The self-view hole element — measured to report its rect to native so the local-camera surface is
   *  positioned over it. Null on AUDIO calls (no self-view rendered). */
  private readonly selfHole = viewChild<ElementRef<HTMLElement>>('selfHole');
  private readonly remoteVideo =
    viewChild<ElementRef<HTMLVideoElement>>('remoteVideo');
  private readonly selfVideo =
    viewChild<ElementRef<HTMLVideoElement>>('selfVideo');

  constructor() {
    // Report the video-hole rects to native once mounted + on viewport change, so the SurfaceViewRenderer
    //  overlays track the Angular layout. (scroll is captured so it catches scroll in any nested scroller.)
    //  A full ResizeObserver on the holes is Phase 4 polish; resize+scroll covers the common cases.
    afterNextRender(() => {
      this.reportVideoRects();
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('scroll', this.onViewportChange, true);
    });
    // Auto-hide the chrome in a steady connected VIDEO call (immersive viewing); reveal it for every other
    //  phase (so ringing / connecting / reconnecting keep the controls reachable). Re-arms on each phase change.
    effect(() => {
      if (this.presentation.minimized()) {
        this.adapter.setVideoRect(null, null);
        this.adapter.setVideoElements(null, null);
      } else if (this.isVideo()) {
        setTimeout(() => this.reportVideoRects());
      }
    });
    effect(() => {
      const phase = this.snap().phase;
      if (this.isVideo() && phase === 'connected') this.scheduleHide();
      else {
        if (this.hideTimer) clearTimeout(this.hideTimer);
        this.controlsVisible.set(true);
      }
    });
    effect(() => {
      const phase = this.snap().phase;
      this.ringtone.setMode(
        phase === 'incoming'
          ? 'incoming'
          : phase === 'ringing'
            ? 'ringback'
            : phase === 'ended' && this.snap().terminalReason === 'busy'
              ? 'busy'
              : phase === 'ended'
                ? 'ended'
                : null,
      );
    });
    // AUDIO→VIDEO changes the rendered holes without remounting this component. Report after Angular has
    // created the self-view element so the media owner can attach both video renderers immediately.
    effect(() => {
      this.isVideo();
      requestAnimationFrame(() => this.reportVideoRects());
    });
    // A new call, camera-off transition, or renderer video remount must show the avatar until an actual
    // decoded frame is ready. `remoteCameraEnabled` alone only means the peer intends to send video.
    effect(() => {
      const sid = this.snap().callSid;
      const enabled = this.snap().remoteCameraEnabled;
      if (sid !== this.lastVideoCallSid || !enabled)
        this.remoteVideoReady.set(false);
      this.lastVideoCallSid = sid;
    });
    // React to PiP enter/exit (native pushes via window.__SOMS_PIP__). In PiP the chrome hides + the self
    //  surface detaches so only the remote video shows in the PiP window; on exit both restore.
    window.__SOMS_PIP__ = (v) => {
      this.inPip.set(v);
      // Native owns the media-surface switch synchronously. On exit, wait for Angular to remount the
      // self-view hit frame before committing its normal layout; entering needs no Web→native round trip.
      if (!v) requestAnimationFrame(() => this.reportVideoRects());
    };
  }

  private readonly onViewportChange = (): void => {
    // Re-clamp the self-view into the (possibly resized) viewport, then re-report so the native surface tracks.
    this.selfLeft.set(
      this.clamp(
        this.selfLeft(),
        0,
        window.innerWidth - CallScreenComponent.SELF_W,
      ),
    );
    this.selfTop.set(
      this.clamp(
        this.selfTop(),
        0,
        window.innerHeight - CallScreenComponent.SELF_H,
      ),
    );
    this.reportVideoRects();
  };

  /** Drag the self-view PiP. Pointer capture holds the gesture even if the finger leaves the small hole; a
   *  drag vs a tap is decided in onSelfPointerUp by total travel (< 8px = tap → swap self↔peer). */
  onSelfPointerDown(e: PointerEvent): void {
    e.stopPropagation(); // the PiP is its own surface: a drag/tap here swaps video, not the main chrome
    this.dragging = true;
    this.dragOrigin = {
      px: e.clientX,
      py: e.clientY,
      left: this.selfLeft(),
      top: this.selfTop(),
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onSelfPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.selfLeft.set(
      this.clamp(
        this.dragOrigin.left + (e.clientX - this.dragOrigin.px),
        0,
        window.innerWidth - CallScreenComponent.SELF_W,
      ),
    );
    this.selfTop.set(
      this.clamp(
        this.dragOrigin.top + (e.clientY - this.dragOrigin.py),
        0,
        window.innerHeight - CallScreenComponent.SELF_H,
      ),
    );
    this.schedulePositionSync();
  }

  onSelfPointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    const moved = Math.hypot(
      e.clientX - this.dragOrigin.px,
      e.clientY - this.dragOrigin.py,
    );
    if (moved < 8) this.adapter.swapVideo(); // a tap (not a drag) → swap which video is full-bleed vs PiP
    this.reportVideoRects();
  }

  private clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Coalesce drag movement to one native compositor translation per animation frame. Full rect/layout
   *  synchronization happens only on pointer-up, resize, mount, and visibility changes. */
  private schedulePositionSync(): void {
    if (this.rectReportPending) return;
    this.rectReportPending = true;
    requestAnimationFrame(() => {
      this.rectReportPending = false;
      if (this.dragging) {
        this.adapter.setSelfVideoPosition(this.selfLeft(), this.selfTop());
      }
    });
  }

  /** Tell native where to mount/position the video surfaces: the remote video is full-bleed (the whole call
   *  screen), the self-view sits over its hole. Passes nulls on AUDIO / unmount so native detaches. */
  private reportVideoRects(): void {
    if (!this.isVideo() || this.snap().phase === 'idle') {
      this.adapter.setVideoElements(null, null);
      this.adapter.setVideoRect(null, null);
      return;
    }
    this.adapter.setVideoElements(
      this.remoteVideo()?.nativeElement ?? null,
      this.selfVideo()?.nativeElement ?? null,
    );
    const remote = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    // In PiP only the remote video shows (the self PiP is hidden) → pass self=null so native detaches it.
    if (this.inPip()) {
      this.adapter.setVideoRect(JSON.stringify(remote), null);
      return;
    }
    const self = this.selfHole()?.nativeElement;
    this.adapter.setVideoRect(
      JSON.stringify(remote),
      self ? JSON.stringify(this.rectOf(self)) : null,
    );
  }

  private rectOf(el: HTMLElement): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  }

  readonly isVideo = computed(() => this.snap().callType === 'VIDEO');
  readonly waitingForRemoteVideo = computed(
    () =>
      this.isVideo() &&
      this.snap().remoteCameraEnabled &&
      this.adapter.rendererOwnsVideo === true &&
      !this.remoteVideoReady(),
  );
  readonly showRemotePlaceholder = computed(
    () => !this.snap().remoteCameraEnabled || this.waitingForRemoteVideo(),
  );
  readonly canUpgradeVideo = computed(
    () =>
      this.snap().phase === 'connected' || this.snap().phase === 'reconnecting',
  );
  /** Exposed for the template (the avatar component's [type] input). */
  readonly UserAvatarType = UserAvatarType;
  readonly AppIconType = AppIconType;
  readonly actionIconSize = { width: '24px', height: '24px' };

  readonly statusLabel = computed(() => {
    // Prefer the finer WebRTC step ("offer-sent"/"answer-received"/…) when the native FSM has set one; fall
    // back to the coarse phase label. Both are stable codes localized via the `call` i18n namespace (the native
    // FSM sends codes, never display text — per the UI-text bilingual convention).
    if (this.snap().phase === 'reconnecting') {
      return this.transloco.translate('call.reconnecting');
    }
    if (this.snap().videoUpgradeState === 'upgrading') {
      return this.transloco.translate('call.startingVideo');
    }
    if (this.snap().videoUpgradeState === 'failed') {
      return this.transloco.translate('call.videoUpgradeFailed');
    }
    if (this.waitingForRemoteVideo()) {
      return this.transloco.translate('call.waitingForVideo');
    }
    const step = this.snap().step;
    if (step) return this.transloco.translate(`call.${step}`);
    switch (this.snap().phase) {
      case 'starting':
        return this.transloco.translate('call.starting');
      case 'incoming':
        return this.transloco.translate('call.incoming');
      case 'calling':
        return this.transloco.translate('call.calling');
      case 'ringing':
        return this.transloco.translate('call.ringing');
      case 'connecting':
        return this.transloco.translate('call.connecting');
      case 'ended':
        switch (this.snap().terminalReason) {
          case 'declined':
            return this.transloco.translate('call.peerDeclined');
          case 'busy':
            return this.transloco.translate('call.peerBusy');
          case 'missed':
            return this.transloco.translate('call.peerMissed');
          case 'timeout':
            return this.transloco.translate('call.peerTimeout');
          case 'failed':
            return this.transloco.translate('call.peerDisconnected');
          case 'cancelled':
            return this.transloco.translate('call.peerCancelled');
          default:
            return this.transloco.translate('call.ended');
        }
      default:
        return '';
    }
  });

  readonly timer = computed(() => {
    const start = this.snap().startedAt;
    if (!start) return '0:00';
    const s = Math.max(0, Math.floor((this.now() - start) / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  });

  /** Any pointer down on the call screen reveals the controls + re-arms the auto-hide. The self-PiP is
   *  excluded (its pointerdown stops propagation — it swaps video, not chrome). */
  onScreenTap(): void {
    this.revealControls();
  }

  /** Desktop pointer activity keeps the video controls visible. Every mouse movement restarts the inactivity
   *  countdown; touch movement is intentionally excluded so a finger drag does not keep the chrome open. */
  onScreenMouseMove(): void {
    this.revealControls();
  }

  onRemoteVideoReady(): void {
    if (this.snap().remoteCameraEnabled) this.remoteVideoReady.set(true);
  }

  /** Show the controls now; in a connected video call, re-arm the auto-hide so they fade again after inactivity. */
  revealControls(): void {
    this.controlsVisible.set(true);
    if (this.isVideo() && this.snap().phase === 'connected')
      this.scheduleHide();
  }

  private scheduleHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(
      () => this.controlsVisible.set(false),
      CallScreenComponent.HIDE_DELAY_MS,
    );
  }

  accept(): void {
    const sid = this.snap().callSid;
    if (sid) this.adapter.accept(sid);
  }
  minimize(): void {
    this.presentation.minimize();
  }
  restore(): void {
    this.presentation.restore();
  }
  decline(): void {
    const sid = this.snap().callSid;
    if (sid) {
      this.events.markLocalTermination(sid);
      this.adapter.decline(sid);
    }
  }
  hangUp(): void {
    const s = this.snap();
    const sid = s.callSid;
    if (!sid) return;
    this.events.markLocalTermination(sid);
    // Pre-accept (the caller is still 'calling'/'ringing'): the server's /calls/end REJECTS a ringing call
    // (CALL_NOT_FOUND), which would leave it live server-side → busy lockout + the peer's incoming UI never
    // dismissed. /calls/cancel is the ringing-state terminal (releases both parties). Post-accept → end.
    if (
      s.phase === 'starting' ||
      s.phase === 'calling' ||
      s.phase === 'ringing'
    ) {
      this.adapter.cancel(sid);
    } else {
      this.adapter.end(sid, 'completed');
    }
  }
  toggleMute(): void {
    this.adapter.setMuted(!this.snap().muted);
  }
  toggleSpeaker(): void {
    this.adapter.setSpeakerEnabled(!this.snap().speakerEnabled);
  }

  /** One-way AUDIO→VIDEO transition. The media adapter owns permission + SDP renegotiation; audio remains
   *  connected throughout, and a failed upgrade can be retried without disturbing the call. */
  upgradeToVideo(): void {
    if (
      !this.isVideo() &&
      this.canUpgradeVideo() &&
      this.snap().videoUpgradeState !== 'upgrading'
    ) {
      this.adapter.upgradeToVideo();
    }
  }

  /** Camera on/off (video only): toggles the local video track natively + the self-view placeholder state. */
  toggleCamera(): void {
    this.adapter.setCameraEnabled(!this.snap().cameraEnabled);
  }

  /** Switch the capture between the front (self-view) + back cameras (WhatsApp/FaceTime "flip"). */
  switchCamera(): void {
    this.adapter.switchCamera();
  }

  ngOnDestroy(): void {
    clearInterval(this.timerHandle);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.ringtone.setMode(null);
    window.__SOMS_PIP__ = undefined;
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    // Detach the native video surfaces (no chrome to host them anymore).
    this.adapter.setVideoRect(null, null);
  }
}
