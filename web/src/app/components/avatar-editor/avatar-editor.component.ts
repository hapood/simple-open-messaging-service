import {
  Component,
  input,
  output,
  signal,
  computed,
  effect,
  inject,
  OnInit,
  OnDestroy,
  ElementRef,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { PageHeaderComponent } from '../page-header/page-header.component';
import {
  computeCropRect,
  clampOffset,
  minCoverScale,
  maxZoomScale,
  clamp,
} from './crop-rect';

/**
 * Square avatar cropper (Edit Profile → "change avatar").
 *
 * The picked file is decoded with EXIF applied (so the preview matches the
 * backend's sharp .rotate() output), shown in a fixed 1:1 frame the user pans
 * (drag) and zooms (slider / wheel / pinch). On "Done" the visible square is
 * drawn from the source bitmap to a PNG and returned to the opener, which
 * uploads it through the existing update-avatar endpoint. The backend still
 * re-crops to square + emits its WebP sizes — a square input makes that a no-op.
 *
 * Zoneless notes: pan runs on imperative pointer listeners that mutate plain
 * fields and call draw() directly (no signal writes → no change-detection storm).
 * Only the zoom slider is signal-driven; wheel/pinch write the scale directly and
 * mirror it back to the slider via an idempotent effect.
 */
@Component({
  selector: 'app-avatar-editor',
  imports: [
    MatButtonModule,
    PageHeaderComponent,
    FitDialogDirective,
    TranslocoPipe,
  ],
  templateUrl: './avatar-editor.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './avatar-editor.component.scss',
})
export class AvatarEditorComponent implements OnInit, OnDestroy {
  private readonly routeService = inject(RouteService);
  private readonly transloco = inject(TranslocoService);

  /** picked file, supplied via popupDlg(PopupType.AVATAR_EDITOR, { file }). */
  readonly file = input.required<File>();
  /** Embedded mode keeps the cropper inside its parent surface instead of closing a popup. */
  readonly embedded = input(false);
  readonly canceled = output<void>();
  readonly completed = output<File>();
  readonly fitOpts = { minHeight: 360 } as const;

  /** Backing-store side of the square frame. Output quality comes from the source
   *  bitmap, not the preview, so this only needs to be comfortable on screen. */
  readonly FRAME = 288;
  /** Never emit wider than this: 2× the largest backend size (512) → crisp
   *  downscale headroom, well under the 10 MB multipart / 16 MP pixel-bomb guards. */
  private readonly MAX_OUT = 1024;
  /** Mirror the backend avatar whitelist (upload.service.ts). */
  private readonly ACCEPTED = [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ];
  private readonly MAX_FILE = 10 * 1024 * 1024;

  /** 0..1 slider position, mapped linearly to scale ∈ [minScale, maxScale]. */
  readonly zoom = signal(0);
  readonly decoded = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly canSave = computed(
    () => this.decoded() && !this.busy() && !this.error(),
  );

  private readonly cropCanvas =
    viewChild<ElementRef<HTMLCanvasElement>>('crop');

  private bmp: ImageBitmap | null = null;
  private iw = 0;
  private ih = 0;
  private scale = 0;
  private ox = 0;
  private oy = 0;
  private minScale = 0;
  private maxScale = 0;
  private ctx: CanvasRenderingContext2D | null = null;
  private hostCanvas: HTMLCanvasElement | null = null;
  private wired = false;

  /** active pointers for pan / pinch (pointerId → canvas-space position). */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinchStartDist = 0;
  private pinchStartScale = 0;

  constructor() {
    // Slider / wheel / pinch all funnel through `zoom`; recompute scale about the
    // frame center and redraw. Idempotent guard: wheel/pinch already set `scale`,
    // so the effect only acts when the slider actually moves it.
    effect(() => {
      const z = this.zoom();
      if (!this.minScale) return;
      const target = clamp(
        this.minScale + (this.maxScale - this.minScale) * z,
        this.minScale,
        this.maxScale,
      );
      if (Math.abs(target - this.scale) < 1e-4) return;
      this.setZoomAt(target, this.FRAME / 2, this.FRAME / 2);
      this.draw();
    });

    // The canvas may resolve after the image; grab its context and draw once both exist.
    effect(() => {
      const crop = this.cropCanvas();
      if (crop) {
        this.ensureContexts();
        if (this.bmp) this.draw();
      }
    });
  }

  ngOnInit() {
    void this.loadImage(this.file());
  }

  ngOnDestroy() {
    this.detachPointer();
    if (this.hostCanvas)
      this.hostCanvas.removeEventListener('wheel', this.onWheel);
    this.bmp?.close();
    this.bmp = null;
  }

  private async loadImage(file: File) {
    if (!this.ACCEPTED.includes(file.type)) {
      this.error.set(this.transloco.translate('profile.avatarErrorFormat'));
      return;
    }
    if (file.size > this.MAX_FILE) {
      this.error.set(this.transloco.translate('profile.avatarErrorSize'));
      return;
    }
    try {
      // imageOrientation:'from-image' applies EXIF orientation on decode so phone
      // photos don't surprise us with a 90° flip vs. the backend. Fall back to a
      // plain decode on browsers that reject the option.
      try {
        this.bmp = await createImageBitmap(file, {
          imageOrientation: 'from-image',
        });
      } catch {
        this.bmp = await createImageBitmap(file);
      }
      this.iw = this.bmp.width;
      this.ih = this.bmp.height;
      this.minScale = minCoverScale(this.iw, this.ih, this.FRAME);
      this.maxScale = Math.max(
        maxZoomScale(this.iw, this.ih, this.FRAME),
        this.minScale,
      );
      // start fully zoomed-out (cover), centered
      this.scale = this.minScale;
      const c = clampOffset(0, 0, this.iw, this.ih, this.FRAME, this.scale);
      this.ox = c.ox;
      this.oy = c.oy;
      this.decoded.set(true);
      this.ensureContexts();
      this.draw();
    } catch {
      this.error.set(this.transloco.translate('profile.avatarErrorRead'));
    }
  }

  /** Resolve the 2D contexts and attach the always-on gesture listeners. Idempotent. */
  private ensureContexts() {
    const crop = this.cropCanvas()?.nativeElement;
    if (crop && !this.ctx) {
      this.ctx = crop.getContext('2d');
      this.hostCanvas = crop;
    }
    if (this.hostCanvas && !this.wired) {
      this.wired = true;
      this.hostCanvas.addEventListener('pointerdown', this.onPointerDown);
      // non-passive so we can preventDefault and stop the page from zooming/scrolling
      this.hostCanvas.addEventListener('wheel', this.onWheel, {
        passive: false,
      });
    }
  }

  // ── transform helpers ──────────────────────────────────────────────────────

  /** Zoom to `ns`, keeping the source point under (cx, cy) fixed. */
  private setZoomAt(ns: number, cx: number, cy: number) {
    if (!this.scale) {
      this.scale = ns;
      return;
    }
    const sx = (cx - this.ox) / this.scale;
    const sy = (cy - this.oy) / this.scale;
    this.scale = ns;
    const cl = clampOffset(
      cx - sx * ns,
      cy - sy * ns,
      this.iw,
      this.ih,
      this.FRAME,
      ns,
    );
    this.ox = cl.ox;
    this.oy = cl.oy;
  }

  /** Mirror a direct (wheel/pinch) scale back onto the slider signal. */
  private syncZoomSignal(scale: number) {
    if (this.maxScale > this.minScale) {
      this.zoom.set(
        clamp((scale - this.minScale) / (this.maxScale - this.minScale), 0, 1),
      );
    }
  }

  private toCanvasPoint(clientX: number, clientY: number) {
    const r = this.hostCanvas!.getBoundingClientRect();
    return {
      x: (clientX - r.left) * (this.FRAME / r.width),
      y: (clientY - r.top) * (this.FRAME / r.height),
    };
  }

  // ── pan / pinch (imperative; no signal writes) ─────────────────────────────

  private onPointerDown = (e: PointerEvent) => {
    const c = this.hostCanvas;
    if (!c) return;
    c.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.toCanvasPoint(e.clientX, e.clientY));
    if (this.pointers.size === 2) {
      this.pinchStartDist = this.pinchDistance();
      this.pinchStartScale = this.scale;
    }
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const cur = this.toCanvasPoint(e.clientX, e.clientY);
    if (this.pointers.size >= 2) {
      this.pointers.set(e.pointerId, cur);
      this.doPinch();
    } else {
      // pan 1:1 in canvas px (drag the image with the pointer)
      const prev = this.pointers.get(e.pointerId)!;
      const cl = clampOffset(
        this.ox + cur.x - prev.x,
        this.oy + cur.y - prev.y,
        this.iw,
        this.ih,
        this.FRAME,
        this.scale,
      );
      this.ox = cl.ox;
      this.oy = cl.oy;
      this.pointers.set(e.pointerId, cur);
    }
    this.draw();
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStartDist = 0;
    if (this.pointers.size === 0) this.detachPointer();
  };

  private detachPointer() {
    const c = this.hostCanvas;
    if (!c) return;
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
  }

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private doPinch() {
    if (!this.pinchStartDist || !this.pinchStartScale) return;
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    const ns = clamp(
      this.pinchStartScale *
        (Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStartDist),
      this.minScale,
      this.maxScale,
    );
    this.setZoomAt(ns, (a.x + b.x) / 2, (a.y + b.y) / 2);
    this.syncZoomSignal(ns);
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.minScale) return;
    const ns = clamp(
      this.scale * Math.exp(-e.deltaY * 0.0015),
      this.minScale,
      this.maxScale,
    );
    const p = this.toCanvasPoint(e.clientX, e.clientY);
    this.setZoomAt(ns, p.x, p.y);
    this.syncZoomSignal(ns);
    this.draw();
  };

  // ── template handlers ──────────────────────────────────────────────────────

  onRange(e: Event) {
    this.zoom.set(+(e.target as HTMLInputElement).value);
  }

  cancel() {
    if (this.embedded()) this.canceled.emit();
    else this.routeService.closeDlg();
  }

  async save() {
    if (!this.canSave() || !this.bmp) return;
    this.busy.set(true);
    try {
      const r = computeCropRect(
        this.iw,
        this.ih,
        this.FRAME,
        this.scale,
        this.ox,
        this.oy,
        this.MAX_OUT,
      );
      const oc = document.createElement('canvas');
      oc.width = r.out;
      oc.height = r.out;
      const octx = oc.getContext('2d')!;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(this.bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, r.out, r.out);
      const blob = await new Promise<Blob | null>((res) =>
        oc.toBlob(res, 'image/png'),
      );
      if (!blob) throw new Error('encode failed');
      const file = new File([blob], 'avatar.png', { type: 'image/png' });
      if (this.embedded()) this.completed.emit(file);
      else this.routeService.closeDlg({ file });
    } catch {
      this.error.set(this.transloco.translate('profile.avatarErrorProcess'));
    } finally {
      this.busy.set(false);
    }
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  private draw() {
    const ctx = this.ctx;
    if (!ctx || !this.bmp || !this.scale) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.FRAME, this.FRAME);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.FRAME, this.FRAME);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
    ctx.drawImage(this.bmp, 0, 0);
    ctx.restore();
    // The crop region is the full square canvas, so there's nothing to darken
    // outside it. The rounded-square outer shape comes from the CSS border-radius
    // on `.crop`, matching how a real avatar renders (see avatar-editor.scss).
  }
}
