import {
  ChangeDetectionStrategy,
  Component,
  TemplateRef,
  input,
  output,
} from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { NgTemplateOutlet } from '@angular/common';

/** Fixed-height, cursor-paged virtual list. Callers own data fetching and item presentation. */
@Component({
  selector: 'app-virtual-infinite-list',
  imports: [ScrollingModule, NgTemplateOutlet],
  template: `
    <cdk-virtual-scroll-viewport
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
      @if (loading()) {
        <div class="tail" role="status">{{ loadingLabel() }}</div>
      }
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
    .tail {
      height: 40px;
      display: grid;
      place-items: center;
      color: var(--app-text-muted);
      font-size: 13px;
      line-height: 18px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VirtualInfiniteListComponent<T extends { id: string | number }> {
  readonly items = input.required<readonly T[]>();
  readonly itemTemplate = input.required<TemplateRef<{ $implicit: T }>>();
  readonly itemSize = input.required<number>();
  readonly loading = input(false);
  readonly hasMore = input(false);
  readonly loadingLabel = input('');
  readonly loadMore = output<void>();

  readonly trackByKey = (_index: number, item: T) => item.id;

  onIndex(index: number): void {
    if (
      this.hasMore() &&
      !this.loading() &&
      index + 8 >= this.items().length
    )
      this.loadMore.emit();
  }
}
