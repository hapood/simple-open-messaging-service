import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { VirtualInfiniteListComponent } from './virtual-infinite-list.component';

@Component({
  imports: [VirtualInfiniteListComponent],
  template: `
    <ng-template #row let-item
      ><span class="row">{{ item.key }}</span></ng-template
    >
    <app-virtual-infinite-list
      [items]="items()"
      [itemTemplate]="row"
      [itemKey]="key"
      [itemSize]="64"
      [loading]="loading()"
      [hasMore]="hasMore()"
      [active]="active()"
      [resetKey]="reset()"
      (loadMore)="loadMore()"
    />
  `,
})
class Host {
  readonly items = signal(Array.from({ length: 50 }, (_, key) => ({ key })));
  readonly key = (_index: number, item: { key: number }) => item.key;
  readonly loading = signal(false);
  readonly hasMore = signal(true);
  readonly active = signal(true);
  readonly reset = signal(0);
  readonly loadMore = vi.fn();
}

describe('VirtualInfiniteListComponent', () => {
  function create() {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (callback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
      },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const list = fixture.debugElement.query(
      By.directive(VirtualInfiniteListComponent),
    ).componentInstance as VirtualInfiniteListComponent<{ key: number }>;
    const viewport = fixture.debugElement.query(
      By.directive(CdkVirtualScrollViewport),
    ).componentInstance as CdkVirtualScrollViewport;
    const height = vi.spyOn(viewport, 'getViewportSize').mockReturnValue(640);
    const offset = vi.spyOn(viewport, 'measureScrollOffset').mockReturnValue(0);
    const flush = () => {
      fixture.detectChanges();
      list.scheduleCheck();
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    return {
      fixture,
      host: fixture.componentInstance,
      list,
      viewport,
      height,
      offset,
      flush,
      frames,
    };
  }

  it('loads near the visible end, not just a hard-coded start index', () => {
    const { host, offset, flush } = create();
    flush();
    expect(host.loadMore).not.toHaveBeenCalled();
    offset.mockReturnValue(36 * 64);
    flush();
    flush();
    expect(host.loadMore).toHaveBeenCalledOnce();
  });

  it('fills an underfilled viewport and checks newly appended pages without another scroll', () => {
    const { host, flush } = create();
    host.items.set([{ key: 1 }]);
    flush();
    expect(host.loadMore).toHaveBeenCalledTimes(1);
    host.loading.set(true);
    host.items.set([{ key: 1 }, { key: 2 }]);
    flush();
    expect(host.loadMore).toHaveBeenCalledTimes(1);
    host.loading.set(false);
    flush();
    expect(host.loadMore).toHaveBeenCalledTimes(2);
    host.hasMore.set(false);
    host.items.set([{ key: 1 }, { key: 2 }, { key: 3 }]);
    flush();
    expect(host.loadMore).toHaveBeenCalledTimes(2);
  });

  it('does not automatically retry the same failed page', () => {
    const { host, flush } = create();
    host.items.set([]);
    flush();
    host.loading.set(true);
    flush();
    host.loading.set(false);
    flush();
    expect(host.loadMore).toHaveBeenCalledOnce();
  });

  it('waits for a hidden tab to become active and acquire a viewport', () => {
    const { host, height, flush } = create();
    host.items.set([]);
    host.active.set(false);
    flush();
    expect(host.loadMore).not.toHaveBeenCalled();
    host.active.set(true);
    height.mockReturnValue(0);
    flush();
    expect(host.loadMore).not.toHaveBeenCalled();
    height.mockReturnValue(640);
    flush();
    expect(host.loadMore).toHaveBeenCalledOnce();
  });

  it('resets scroll position and request gating for a new search', () => {
    const { host, viewport, flush } = create();
    const scroll = vi.spyOn(viewport, 'scrollToIndex');
    host.items.set([]);
    flush();
    host.reset.update((value) => value + 1);
    flush();
    expect(scroll).toHaveBeenCalledWith(0, 'auto');
    expect(host.loadMore).toHaveBeenCalledTimes(2);
  });

  it('uses caller-owned stable identity keys and cancels queued checks on destruction', () => {
    const { list, fixture, frames } = create();
    expect(list.trackByKey(3, { key: 42 })).toBe(42);
    list.scheduleCheck();
    expect(frames.size).toBeGreaterThan(0);
    fixture.destroy();
    expect(frames.size).toBe(0);
  });
});
