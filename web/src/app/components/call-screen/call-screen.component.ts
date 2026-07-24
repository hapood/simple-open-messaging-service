import { afterNextRender, Component, computed, ElementRef, inject, OnDestroy, signal, viewChild } from '@angular/core';
import { CallEventService } from '../../services/call-event.service';
import { CallAdapterService } from '../../services/call-adapter';
import { assetUrl } from '../../services/runtime';

/**
 * The 1:1 call UI — a fullscreen overlay mounted at the app root (AppComponent), shown whenever a call is
 * active (CallEventService.callState.phase !== 'idle'). It is the Angular "chrome" over the NATIVE call:
 * it reads the merged call state signal + drives the native CallController via CallAdapterService. The media
 * leg (RTCPeerConnection, audio/video) lives entirely in native Kotlin (CallController) — this component
 * never touches WebRTC.
 *
 * AUDIO layout: centered avatar/name + status + Mute + End.
 * VIDEO layout (callType === 'VIDEO'): the `.call-screen` is full-bleed + transparent (the native sibling
 * SurfaceViewRenderer renders the REMOTE video BEHIND it — the barcode-scanner overlay technique); a
 * draggable-position `.self-view` hole is where native renders the LOCAL camera; the controls gain a
 * camera-switch (front↔back) + camera on/off button. The peer name + status float at the top. This matches
 * the mainstream-app layout (WhatsApp/FaceTime/WeChat).
 *
 * The video surfaces are positioned natively via `adapter.setVideoRect(remoteRect, selfRect)` — reported by
 * this component (ResizeObserver on the holes). That rect reporting + the native VideoCapturer/renderers
 * land with the Phase 4 native half; until then the video holes are transparent placeholders + the camera
 * buttons call the adapter (functional once native implements switchCamera/setCameraEnabled).
 *
 * Terminal phases are folded to 'idle' by CallEventService, so the overlay dismisses on hang-up / decline /
 * peer-end; the terminal CALL bubble in the thread is the user-visible record.
 *
 * Rendered at z-index 1200 (above the lightbox tier at 1100 — a call is the topmost surface). Hardcoded
 * English labels for Phase 3; bilingual i18n keys are a follow-up (per the UI-text convention).
 */
@Component({
  selector: 'app-call-screen',
  standalone: true,
  template: `
    @if (snap().phase !== 'idle') {
      <div class="call-screen" [class.video]="isVideo()">
        @if (isVideo()) {
          <!-- The self-view hole: native renders the LOCAL camera here (positioned top-right, the
               mainstream-app "picture-in-picture" self preview). Transparent until native attaches. -->
          <div class="self-view"
               [class.off]="!cameraOn()"
               [style.left.px]="selfLeft()"
               [style.top.px]="selfTop()"
               (pointerdown)="onSelfPointerDown($event)"
               (pointermove)="onSelfPointerMove($event)"
               (pointerup)="onSelfPointerUp($event)"
               (pointercancel)="onSelfPointerUp($event)"
               #selfHole>
            @if (!cameraOn()) {
              <span class="self-off">Camera off</span>
            }
          </div>
        }

        <div class="top-bar">
          <div class="name">{{ snap().peerName || '…' }}</div>
          <div class="status">{{ statusLabel() }}</div>
          @if (snap().phase === 'connected' || snap().phase === 'reconnecting') {
            <div class="timer">{{ timer() }}</div>
          }
        </div>

        @if (!isVideo()) {
          <!-- AUDIO: centered avatar. VIDEO: the avatar would sit behind the remote video, so hide it. -->
          <div class="peer">
            @if (avatarSrc()) {
              <img class="avatar" [src]="avatarSrc()" alt="" />
            } @else {
              <div class="avatar avatar-fallback">{{ initial() }}</div>
            }
          </div>
        }

        <div class="controls">
          @switch (snap().phase) {
            @case ('incoming') {
              <button class="btn decline" type="button" (click)="decline()">Decline</button>
              <button class="btn accept" type="button" (click)="accept()">Accept</button>
            }
            @default {
              <button class="btn mute" [class.on]="snap().muted" type="button" (click)="toggleMute()">
                {{ snap().muted ? 'Unmute' : 'Mute' }}
              </button>
              @if (isVideo()) {
                <button
                  class="btn cam"
                  [class.on]="!cameraOn()"
                  type="button"
                  (click)="toggleCamera()"
                >{{ cameraOn() ? 'Cam off' : 'Cam on' }}</button>
                <button class="btn switch" type="button" (click)="switchCamera()">Flip</button>
              }
              <button class="btn end" type="button" (click)="hangUp()">End</button>
            }
          }
        </div>
      </div>
    }
  `,
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
        gap: 24px;
        background: #0b0b0f;
        color: #fff;
      }
      /* VIDEO: full-bleed + transparent so the native remote SurfaceViewRenderer (a sibling view BEHIND the
         WebView, via the barcode-scanner overlay technique) shows through. The native side sets the WebView
         background TRANSPARENT while a video call is active. */
      .call-screen.video {
        background: transparent;
        justify-content: flex-end;
        padding-bottom: 48px;
      }
      .self-view {
        position: absolute;
        width: 120px;
        height: 160px;
        /* touch-action:none lets the pointer drag own the gesture (the browser won't steal it as scroll/zoom). */
        touch-action: none;
        /* No frame: this div is a transparent positioning anchor + the drag/tap target. The native self
           SurfaceViewRenderer (a media-overlay sibling BEHIND this hole) draws the actual video, positioned
           over it via reportVideoRects. Position (left/top) is bound to selfLeft()/selfTop() (draggable). */
        background: transparent;
      }
      .self-view.off {
        display: flex;
        align-items: center;
        justify-content: center;
        /* Camera off → the native track is disabled (frozen/black surface); an opaque bg so the label reads. */
        background: rgba(0, 0, 0, 0.6);
      }
      .self-off {
        font-size: 12px;
        line-height: 16px;
        opacity: 0.8;
      }
      .top-bar {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      .peer {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .avatar {
        width: 96px;
        height: 96px;
        border-radius: 48px;
        object-fit: cover;
        background: #333;
      }
      .avatar-fallback {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 40px;
        line-height: 96px;
      }
      .name {
        font-size: 22px;
        line-height: 28px;
      }
      .status {
        font-size: 15px;
        line-height: 20px;
        opacity: 0.8;
        min-height: 20px;
      }
      .timer {
        font-size: 18px;
        line-height: 24px;
        font-variant-numeric: tabular-nums;
      }
      .controls {
        display: flex;
        gap: 16px;
        flex-wrap: wrap;
        justify-content: center;
      }
      .btn {
        min-width: 72px;
        height: 56px;
        padding: 0 20px;
        border: none;
        border-radius: 28px;
        font-size: 15px;
        line-height: 20px;
        color: #fff;
        cursor: pointer;
      }
      .accept {
        background: #2e7d32;
      }
      .decline {
        background: #c62828;
      }
      .mute {
        background: #555;
      }
      .mute.on {
        background: #ff9800;
      }
      .cam {
        background: #555;
      }
      .cam.on {
        background: #ff9800;
      }
      .switch {
        background: #555;
      }
      .end {
        background: #c62828;
      }
    `,
  ],
})
export class CallScreenComponent implements OnDestroy {
  readonly events = inject(CallEventService);
  private readonly adapter = inject(CallAdapterService);

  readonly snap = computed(() => this.events.callState());

  /** A 1s ticking clock so the connected timer updates; read by `timer()`. Cleared in ngOnDestroy. */
  private readonly now = signal(Date.now());
  private readonly timerHandle = setInterval(() => this.now.set(Date.now()), 1000);

  /** Local camera on/off (video only). Mirrored from the native FSM once setVideoRect reports back; until
   *  then this component owns the optimistic toggle. */
  readonly cameraOn = signal(true);

  /** Self-view PiP size (CSS px) — matches the .self-view width/height; used to clamp the drag. */
  private static readonly SELF_W = 120;
  private static readonly SELF_H = 160;
  /** Self-view position (CSS px, viewport-relative) — draggable; the native surface follows via reportVideoRects.
   *  Seeded top-right; clamped to the viewport on drag + resize. */
  readonly selfLeft = signal(typeof window !== 'undefined' ? window.innerWidth - CallScreenComponent.SELF_W - 16 : 0);
  readonly selfTop = signal(64);
  private dragging = false;
  private dragOrigin = { px: 0, py: 0, left: 0, top: 0 };
  /** rAF coalescing flag so a drag burst fires at most one native setVideoRect per animation frame. */
  private rectReportPending = false;

  /** The self-view hole element — measured to report its rect to native so the local-camera surface is
   *  positioned over it. Null on AUDIO calls (no self-view rendered). */
  private readonly selfHole = viewChild<ElementRef<HTMLElement>>('selfHole');

  constructor() {
    // Report the video-hole rects to native once mounted + on viewport change, so the SurfaceViewRenderer
    //  overlays track the Angular layout. (scroll is captured so it catches scroll in any nested scroller.)
    //  A full ResizeObserver on the holes is Phase 4 polish; resize+scroll covers the common cases.
    afterNextRender(() => {
      this.reportVideoRects();
      window.addEventListener('resize', this.onViewportChange);
      window.addEventListener('scroll', this.onViewportChange, true);
    });
  }

  private readonly onViewportChange = (): void => {
    // Re-clamp the self-view into the (possibly resized) viewport, then re-report so the native surface tracks.
    this.selfLeft.set(this.clamp(this.selfLeft(), 0, window.innerWidth - CallScreenComponent.SELF_W));
    this.selfTop.set(this.clamp(this.selfTop(), 0, window.innerHeight - CallScreenComponent.SELF_H));
    this.reportVideoRects();
  };

  /** Drag the self-view PiP. Pointer capture holds the gesture even if the finger leaves the small hole; a
   *  drag vs a tap is decided in onSelfPointerUp by total travel (< 8px = tap → swap self↔peer). */
  onSelfPointerDown(e: PointerEvent): void {
    this.dragging = true;
    this.dragOrigin = { px: e.clientX, py: e.clientY, left: this.selfLeft(), top: this.selfTop() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  onSelfPointerMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.selfLeft.set(this.clamp(this.dragOrigin.left + (e.clientX - this.dragOrigin.px), 0, window.innerWidth - CallScreenComponent.SELF_W));
    this.selfTop.set(this.clamp(this.dragOrigin.top + (e.clientY - this.dragOrigin.py), 0, window.innerHeight - CallScreenComponent.SELF_H));
    this.scheduleRectReport();
  }

  onSelfPointerUp(e: PointerEvent): void {
    if (!this.dragging) return;
    this.dragging = false;
    const moved = Math.hypot(e.clientX - this.dragOrigin.px, e.clientY - this.dragOrigin.py);
    if (moved < 8) this.adapter.swapVideo(); // a tap (not a drag) → swap which video is full-bleed vs PiP
    this.reportVideoRects();
  }

  private clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Coalesce drag-move rect reports to one per animation frame — the native bridge call is cheap, but a drag
   *  burst fires pointermove at touch rate (~60–120/s) and a per-event bridge call would jank. */
  private scheduleRectReport(): void {
    if (this.rectReportPending) return;
    this.rectReportPending = true;
    requestAnimationFrame(() => {
      this.rectReportPending = false;
      this.reportVideoRects();
    });
  }

  /** Tell native where to mount/position the video surfaces: the remote video is full-bleed (the whole call
   *  screen), the self-view sits over its hole. Passes nulls on AUDIO / unmount so native detaches. */
  private reportVideoRects(): void {
    if (!this.isVideo() || this.snap().phase === 'idle') {
      this.adapter.setVideoRect(null, null);
      return;
    }
    const remote = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const self = this.selfHole()?.nativeElement;
    this.adapter.setVideoRect(JSON.stringify(remote), self ? JSON.stringify(this.rectOf(self)) : null);
  }

  private rectOf(el: HTMLElement): { x: number; y: number; w: number; h: number } {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  }

  readonly isVideo = computed(() => this.snap().callType === 'VIDEO');
  readonly avatarSrc = computed(() => {
    const a = this.snap().peerAvatar;
    return a ? assetUrl(a) : '';
  });
  readonly initial = computed(() => this.snap().peerName.charAt(0).toUpperCase() || '?');

  readonly statusLabel = computed(() => {
    switch (this.snap().phase) {
      case 'incoming':
        return 'Incoming call';
      case 'calling':
        return 'Calling…';
      case 'ringing':
        return 'Ringing…';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return 'Reconnecting…';
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

  accept(): void {
    const sid = this.snap().callSid;
    if (sid) this.adapter.accept(sid);
  }
  decline(): void {
    const sid = this.snap().callSid;
    if (sid) this.adapter.decline(sid);
  }
  hangUp(): void {
    const sid = this.snap().callSid;
    if (sid) this.adapter.end(sid, 'completed');
  }
  toggleMute(): void {
    this.adapter.setMuted(!this.snap().muted);
  }

  /** Camera on/off (video only): toggles the local video track natively + the self-view placeholder state. */
  toggleCamera(): void {
    const next = !this.cameraOn();
    this.cameraOn.set(next);
    this.adapter.setCameraEnabled(next);
  }

  /** Switch the capture between the front (self-view) + back cameras (WhatsApp/FaceTime "flip"). */
  switchCamera(): void {
    this.adapter.switchCamera();
  }

  ngOnDestroy(): void {
    clearInterval(this.timerHandle);
    window.removeEventListener('resize', this.onViewportChange);
    window.removeEventListener('scroll', this.onViewportChange, true);
    // Detach the native video surfaces (no chrome to host them anymore).
    this.adapter.setVideoRect(null, null);
  }
}
