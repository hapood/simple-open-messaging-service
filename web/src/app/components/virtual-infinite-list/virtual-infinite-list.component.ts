import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  TemplateRef,
  TrackByFunction,
  viewChild,
} from '@angular/core';
import {
  CdkVirtualScrollViewport,
  ScrollingModule,
} from '@angular/cdk/scrolling';
import { NgTemplateOutlet } from '@angular/common';

/** Fixed-height virtual list. Callers own pagination, errors and item presentation. */
@Component({
  selector: 'app-virtual-infinite-list',
  imports: [ScrollingModule, NgTemplateOutlet],
  template: `
    <cdk-virtual-scroll-viewport
      class="viewport"
      [itemSize]="itemSize()"
      [minBufferPx]="itemSize() * 4"
      [maxBufferPx]="itemSize() * 8"
      [attr.aria-busy]="loading()"
      (scrolledIndexChange)="scheduleCheck()"
    >
      <div
        class="item"
        *cdkVirtualFor="let item of items(); trackBy: trackByKey"
        [style.height.px]="itemSize()"
      >
        <ng-container
          [ngTemplateOutlet]="itemTemplate()"
          [ngTemplateOutletContext]="{ $implicit: item }"
        />
      </div>
    </cdk-virtual-scroll-viewport>
  `,
  styles: `
    :host,
    .viewport {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 0;
    }
    .item {
      box-sizing: border-box;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VirtualInfiniteListComponent<T> {
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly destroyRef = inject(DestroyRef);
  private frame?: number;
  private requestedItems?: readonly T[];

  readonly items = input.required<readonly T[]>();
  readonly itemTemplate = input.required<TemplateRef<{ $implicit: T }>>();
  readonly itemSize = input.required<number>();
  readonly itemKey = input.required<TrackByFunction<T>>();
  readonly hasMore = input(false);
  readonly loading = input(false);
  readonly active = input(true);
  readonly resetKey = input<unknown>(undefined);
  readonly loadMore = output<void>();

  readonly trackByKey: TrackByFunction<T> = (index, item) =>
    this.itemKey()(index, item);

  constructor() {
    afterRenderEffect((onCleanup) => {
      const viewport = this.viewport();
      if (!viewport) return;
      // Material tabs can initially have zero height and become visible later.
      const observer = new ResizeObserver(() => {
        viewport.checkViewportSize();
        this.scheduleCheck();
      });
      observer.observe(viewport.elementRef.nativeElement);
      onCleanup(() => observer.disconnect());
    });
    afterRenderEffect(() => {
      this.resetKey();
      this.requestedItems = undefined;
      this.scrollToTop();
    });
    afterRenderEffect(() => {
      this.items();
      this.hasMore();
      this.loading();
      this.active();
      this.itemSize();
      this.scheduleCheck();
    });
    this.destroyRef.onDestroy(() => {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    });
  }

  scrollToTop(): void {
    this.viewport()?.scrollToIndex(0, 'auto');
    this.scheduleCheck();
  }

  scheduleCheck(): void {
    if (this.destroyRef.destroyed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.checkLoadMore();
    });
  }

  private checkLoadMore(): void {
    const viewport = this.viewport();
    if (!viewport || !this.active() || this.loading() || !this.hasMore())
      return;
    const height = viewport.getViewportSize();
    if (height <= 0) return;
    const items = this.items();
    const visibleEnd = Math.ceil(
      (viewport.measureScrollOffset('top') + height) / this.itemSize(),
    );
    // One automatic request per published page, even if scroll/resize events
    // race with the parent's loading flag. A failed page stays retryable via
    // the caller's error UI rather than creating an automatic retry loop.
    if (visibleEnd + 4 >= items.length && this.requestedItems !== items) {
      this.requestedItems = items;
      this.loadMore.emit();
    }
  }
}
