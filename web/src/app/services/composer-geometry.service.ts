import { Injectable } from '@angular/core';
import { isTauri } from './runtime';

const WIDE_BREAKPOINT_PX = 720;
const COMPACT_HEIGHT_PX = 74;
const WIDE_HEIGHT_PX = 82;

/** Single global writer for the floating composer's CSS height. */
@Injectable({ providedIn: 'root' })
export class ComposerGeometryService {
  private readonly tauri = isTauri();
  private lastHeight = -1;

  constructor() {
    this.syncForWidth(document.documentElement.clientWidth);
  }

  /** Browser/PWA observes the real chat width. Tauri accepts shell geometry only after the boot seed. */
  observe(container: HTMLElement): () => void {
    if (this.tauri) return () => {};
    const sync = (): void => this.syncForWidth(container.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }

  /** Shared by global initialization and every browser width notification. */
  private syncForWidth(width: number): void {
    const height =
      width >= WIDE_BREAKPOINT_PX ? WIDE_HEIGHT_PX : COMPACT_HEIGHT_PX;
    if (height === this.lastHeight) return;
    this.lastHeight = height;
    document.documentElement.style.setProperty(
      '--soms-composer-height',
      `${height}px`,
    );
  }
}
