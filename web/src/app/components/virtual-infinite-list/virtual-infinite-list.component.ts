import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  CdkVirtualScrollViewport,
  ScrollingModule,
} from '@angular/cdk/scrolling';
import { NgTemplateOutlet } from '@angular/common';

/** Fixed-height, cursor-paged virtual list. Callers own data fetching and item presentation. */
@Component({
  selector: 'app-virtual-infinite-list',
  imports: [ScrollingModule, NgTemplateOutlet],
  template: `
    <cdk-virtual-scroll-viewport
      #viewport
      class="viewport"
      [itemSize]="itemSize()"
      [minBufferPx]="itemSize() * 4"
      [maxBufferPx]="itemSize() * 8"
      (scrolledIndexChange)="onIndex($event)"
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
export class VirtualInfiniteListComponent<T extends { id: string | number }> {
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  readonly items = input.required<readonly T[]>();
  readonly itemTemplate = input.required<TemplateRef<{ $implicit: T }>>();
  readonly itemSize = input.required<number>();
  readonly hasMore = input(false);
  readonly loadMore = output<void>();

  readonly trackByKey = (_index: number, item: T) => item.id;

  scrollToTop(): void {
    this.viewport()?.scrollToIndex(0, 'auto');
  }

  onIndex(index: number): void {
    if (this.hasMore() && index + 8 >= this.items().length)
      this.loadMore.emit();
  }
}
