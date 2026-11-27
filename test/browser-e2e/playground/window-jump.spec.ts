import { test, expect } from '../fixtures/playground';
import type { ScrollerApi } from '../../../web/src/app/lib/chat-box/chat-box-scroller';
import type { MessageThreadSource } from '../../../web/src/app/components/message-thread/message-thread-adapter';
import type { MessageThreadAdapter } from '../../../web/src/app/components/message-thread/message-thread-adapter';
import type { ChatSurfaceBinding } from '../../../web/src/app/components/message-thread/chat-surface-lifecycle';

type ThreadProbe = {
  scroller: Pick<ScrollerApi, 'getMountedGeometry' | 'visitMountedGeometry'>;
  source: MessageThreadSource;
  threadAdapter: MessageThreadAdapter;
  interactionActive(): boolean;
  lifecycle: { binding: ChatSurfaceBinding | undefined };
  onSearchJump(id: number): Promise<void>;
};
type ProbeWindow = Window & {
  ng: { getComponent(element: Element): unknown };
  jumpSettled?: boolean;
  failPendingJump: () => void;
  releaseWindowLoad: () => void;
  pendingJump: Promise<void>;
  replacedSources: number;
  jumpSnapshot: {
    kernel: object;
    source: object;
    binding: object | undefined;
    composer: Element;
  };
};

test('missing window target shows a skeleton and recovers through Material action without rebinding composer', async ({
  page,
}) => {
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  const editor = pane.locator('app-chat-input [contenteditable="true"]');
  await editor.fill('keep this draft while jumping');
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    const element = document.querySelector('.pane-fg app-message-thread')!;
    const component = probe.ng.getComponent(element) as unknown as ThreadProbe;
    probe.jumpSnapshot = {
      kernel: component['scroller'],
      source: component['source'],
      binding: component.lifecycle.binding,
      composer: document.querySelector('.pane-fg app-chat-input')!,
    };
    // Hold each replacement window at the adapter boundary until its loading
    // presentation is asserted. Keep the actual source result and kernel real.
    const adapter = component.threadAdapter;
    const create = adapter.createSource.bind(adapter);
    adapter.createSource = (...args) => {
      const source = create(...args);
      const loadWindow = source.loadWindow.bind(source);
      source.loadWindow = async (...loadArgs) => {
        await new Promise<void>((resolve) => {
          probe.releaseWindowLoad = resolve;
        });
        return loadWindow(...loadArgs);
      };
      return source;
    };
    probe.pendingJump = component.onSearchJump(999999999);
  });
  await expect(pane.locator('app-message-window-skeleton')).toBeVisible();
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(editor).toHaveText('keep this draft while jumping');
  await page.evaluate(async () => {
    const probe = window as unknown as ProbeWindow;
    probe.releaseWindowLoad();
    await probe.pendingJump;
  });
  await expect(pane.locator('.msg-window-result')).toContainText(
    'Message not found',
  );
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await pane
    .locator('.msg-window-result')
    .getByRole('button', { name: 'Scroll to latest message', exact: true })
    .click();
  await expect(pane.locator('app-message-window-skeleton')).toBeVisible();
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(pane.locator('.msg-window-result')).toHaveCount(0);
  await expect(editor).toHaveText('keep this draft while jumping');
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).releaseWindowLoad(),
  );
  await expect(pane.locator('app-message-window-skeleton')).toHaveCount(0);
  await expect(pane.locator('.msg-viewport')).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await expect(editor).toHaveText('keep this draft while jumping');
  expect(
    await page.evaluate(() => {
      const probe = window as unknown as ProbeWindow;
      const component = probe.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread')!,
      ) as unknown as ThreadProbe;
      return {
        sameKernel: component['scroller'] === probe.jumpSnapshot.kernel,
        newSource: component['source'] !== probe.jumpSnapshot.source,
        sameBinding: component.lifecycle.binding === probe.jumpSnapshot.binding,
        sameComposer:
          document.querySelector('.pane-fg app-chat-input') ===
          probe.jumpSnapshot.composer,
      };
    }),
  ).toEqual({
    sameKernel: true,
    newSource: true,
    sameBinding: true,
    sameComposer: true,
  });
});

test('initial-load retry recreates only the message window', async ({
  page,
}) => {
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    const controls = probe.ng.getComponent(
      document.querySelector('app-playground-controls')!,
    ) as {
      runtime: MessageThreadAdapter;
    };
    const adapter = controls.runtime;
    const create = adapter.createSource.bind(adapter);
    adapter.createSource = (conversation, entryReadSeq, callbacks) => {
      adapter.createSource = create;
      const source = create(conversation, entryReadSeq, callbacks);
      source.loadWindow = async () => {
        throw new Error('controlled first-load failure');
      };
      return source;
    };
  });
  await page.getByRole('button', { name: /^Alice, chat/ }).click();
  const pane = page.locator('.pane-layer.pane-fg');
  await expect(pane.locator('.msg-load-retry')).toBeVisible();
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    const component = probe.ng.getComponent(
      document.querySelector('.pane-fg app-message-thread')!,
    ) as ThreadProbe;
    probe.jumpSnapshot = {
      kernel: component.scroller,
      source: component.source,
      binding: component.lifecycle.binding,
      composer: document.querySelector('.pane-fg app-chat-input')!,
    };
  });
  await pane.locator('.msg-load-retry').click();
  await expect(pane.locator('.msg-row').first()).toBeVisible();
  await expect(pane.locator('.msg-load-retry')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const probe = window as unknown as ProbeWindow;
      const component = probe.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread')!,
      ) as ThreadProbe;
      return {
        sameKernel: component.scroller === probe.jumpSnapshot.kernel,
        sameBinding: component.lifecycle.binding === probe.jumpSnapshot.binding,
        bindingActive: component.lifecycle.binding?.signal.aborted === false,
        sameComposer:
          document.querySelector('.pane-fg app-chat-input') ===
          probe.jumpSnapshot.composer,
        newSource: component.source !== probe.jumpSnapshot.source,
        foreground: component.interactionActive(),
      };
    }),
  ).toEqual({
    sameKernel: true,
    sameBinding: true,
    bindingActive: true,
    sameComposer: true,
    newSource: true,
    foreground: true,
  });
});

for (const reduced of [false, true]) {
  test(`mounted jumps retain their source and honor motion policy (reduced=${reduced})`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reduced ? 'reduce' : 'no-preference',
    });
    await page.getByRole('button', { name: /^Alice, chat/ }).click();
    const pane = page.locator('.pane-layer.pane-fg');
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    await expect(pane.locator('app-message-window-skeleton')).toHaveCount(0);
    const result = await page.evaluate((reduced) => {
      const probe = window as unknown as ProbeWindow;
      const component = probe.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread')!,
      ) as ThreadProbe;
      const viewport = document.querySelector<HTMLElement>(
        '.pane-fg .msg-viewport',
      )!;
      const source = component.source;
      const kernel = component.scroller;
      const rows: number[] = [];
      kernel.visitMountedGeometry((geometry) => {
        rows.push(geometry.item.id);
      });
      if (rows.length < 3) throw new Error('expected several mounted targets');
      const targets = [
        rows[Math.floor(rows.length / 3)],
        rows[Math.floor((rows.length * 2) / 3)],
      ];
      let inits = 0;
      let creates = 0;
      const loadWindow = source.loadWindow.bind(source);
      const create = component.threadAdapter.createSource.bind(
        component.threadAdapter,
      );
      source.loadWindow = (...args) => {
        inits++;
        return loadWindow(...args);
      };
      component.threadAdapter.createSource = (...args) => {
        creates++;
        return create(...args);
      };
      const calls: Array<{
        behavior: ScrollBehavior | undefined;
        top: number | undefined;
      }> = [];
      const scroll = viewport.scrollTo.bind(viewport);
      // Observe actual browser scrolling rather than replacing the animation.
      viewport.scrollTo = (options?: number | ScrollToOptions, y?: number) => {
        if (typeof options === 'number') scroll(options, y ?? 0);
        else {
          calls.push({ behavior: options?.behavior, top: options?.top });
          scroll(options);
        }
      };
      try {
        // Same-stack inputs guarantee the first motion is still owned when
        // the next jump and user input arrive (no timing sleeps).
        void component.onSearchJump(targets[0]);
        void component.onSearchJump(targets[1]);
        const positionBeforeInput = viewport.scrollTop;
        viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 30 }));
        return {
          targetsMounted: targets.every(
            (id) => kernel.getMountedGeometry(id) !== null,
          ),
          sameSource: component.source === source,
          sameKernel: component.scroller === kernel,
          foreground: component.interactionActive(),
          inits,
          creates,
          behaviors: calls.map((call) => call.behavior),
          stoppedAtInputPosition:
            reduced || calls.at(-1)?.top === positionBeforeInput,
          loading:
            document.querySelector('.pane-fg app-message-window-skeleton') !==
            null,
        };
      } finally {
        viewport.scrollTo = scroll;
        source.loadWindow = loadWindow;
        component.threadAdapter.createSource = create;
      }
    }, reduced);
    expect(result).toEqual({
      targetsMounted: true,
      sameSource: true,
      sameKernel: true,
      foreground: true,
      inits: 0,
      creates: 0,
      behaviors: reduced
        ? ['instant', 'instant']
        : ['smooth', 'instant', 'smooth', 'instant'],
      stoppedAtInputPosition: true,
      loading: false,
    });
    await expect(pane.locator('app-message-window-skeleton')).toHaveCount(0);
    await expect(pane.locator('.msg-window-result')).toHaveCount(0);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  test(`switching conversations during window loading releases the old window before late ${outcome}`, async ({
    page,
  }) => {
    await page.getByRole('button', { name: /^Alice, chat/ }).click();
    const pane = page.locator('.pane-layer.pane-fg');
    await expect(pane.locator('.msg-title-text')).toHaveText('Alice');
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    await pane
      .locator('app-chat-input [contenteditable="true"]')
      .fill('Alice draft survives a cancelled jump');
    await page.evaluate((outcome) => {
      const probe = window as unknown as ProbeWindow;
      const component = probe.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread')!,
      ) as ThreadProbe;
      const adapter = component.threadAdapter;
      const create = adapter.createSource.bind(adapter);
      probe.replacedSources = 0;
      probe.jumpSettled = false;
      // Only the next (Alice jump) source is controlled. Other conversations
      // and subsequent opens keep their normal adapter behavior.
      adapter.createSource = (conversation, entryReadSeq, callbacks) => {
        adapter.createSource = create;
        const source = create(conversation, entryReadSeq, callbacks);
        const destroy = source.destroy.bind(source);
        source.destroy = () => {
          probe.replacedSources++;
          destroy();
        };
        source.loadWindow = () =>
          new Promise((resolve, reject) => {
            probe.failPendingJump = () =>
              outcome === 'resolve'
                ? resolve([])
                : reject(new Error('late cancelled Alice window'));
          });
        return source;
      };
      probe.pendingJump = component.onSearchJump(999999999).then(() => {
        probe.jumpSettled = true;
      });
    }, outcome);
    await expect(pane.locator('app-message-window-skeleton')).toBeVisible();
    await page.getByRole('button', { name: /^Playground Team, chat/ }).click();
    await expect(pane.locator('.msg-title-text')).toHaveText('Playground Team');
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const probe = window as unknown as ProbeWindow;
          return {
            settled: probe.jumpSettled,
            destroyed: probe.replacedSources,
          };
        }),
      )
      .toEqual({ settled: true, destroyed: 1 });
    // Release the abandoned source only after observing synchronous ownership
    // cleanup (including the host's outgoing-pane transition grace period).
    await page.evaluate(async () => {
      (window as unknown as ProbeWindow).failPendingJump();
      await Promise.resolve();
      await Promise.resolve();
    });
    await expect(pane.locator('.msg-title-text')).toHaveText('Playground Team');
    await expect(pane.locator('.msg-window-result')).toHaveCount(0);
    await expect(pane.locator('app-message-window-skeleton')).toHaveCount(0);
    await page.getByRole('button', { name: /^Alice, chat/ }).click();
    await expect(pane.locator('.msg-title-text')).toHaveText('Alice');
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    await expect(pane.locator('.msg-window-result')).toHaveCount(0);
    await expect(
      pane.locator('app-chat-input [contenteditable="true"]'),
    ).toHaveText('Alice draft survives a cancelled jump');
  });
}

for (const mode of ['retry', 'replace'] as const) {
  test(`window jump ${mode} releases the old source and retains only the selected target`, async ({
    page,
  }) => {
    await page.evaluate(() => {
      const probe = window as unknown as ProbeWindow;
      const controls = probe.ng.getComponent(
        document.querySelector('app-playground-controls')!,
      ) as {
        runtime: {
          itemCount: { set(value: number): void };
          sourceLatency: { set(value: number): void };
        };
      };
      controls.runtime.itemCount.set(1000);
      controls.runtime.sourceLatency.set(200);
    });
    await page.getByRole('button', { name: /^Alice, chat/ }).click();
    const pane = page.locator('.pane-layer.pane-fg');
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    const editor = pane.locator('app-chat-input [contenteditable="true"]');
    await editor.fill('retain draft across window replacement');
    await page.evaluate(() => {
      const probe = window as unknown as ProbeWindow;
      const component = probe.ng.getComponent(
        document.querySelector('.pane-fg app-message-thread')!,
      ) as ThreadProbe;
      probe.jumpSnapshot = {
        kernel: component.scroller,
        source: component.source,
        binding: component.lifecycle.binding,
        composer: document.querySelector('.pane-fg app-chat-input')!,
      };
      probe.replacedSources = 0;
      // Inject failure at the mock adapter boundary; keep kernel and UI real.
      const adapter = component.threadAdapter;
      const create = adapter.createSource.bind(adapter);
      let first = true;
      adapter.createSource = (conversation, entryReadSeq, callbacks) => {
        const source = create(conversation, entryReadSeq, callbacks);
        const destroy = source.destroy.bind(source);
        source.destroy = () => {
          probe.replacedSources++;
          destroy();
        };
        if (first) {
          first = false;
          source.loadWindow = () =>
            new Promise((_resolve, reject) => {
              probe.failPendingJump = () =>
                reject(new Error('controlled window load failure'));
            });
        }
        return source;
      };
      // Use interior targets outside the initial read-position window.
      // Entry now opens around the read cursor, not implicitly at the tail.
      if (
        component.scroller.getMountedGeometry(400) ||
        component.scroller.getMountedGeometry(600)
      ) {
        throw new Error(
          'expected replacement targets outside the mounted window',
        );
      }
      probe.pendingJump = component.onSearchJump(400);
    });
    await expect(pane.locator('app-message-window-skeleton')).toBeVisible();
    await expect(editor).toHaveText('retain draft across window replacement');
    if (mode === 'retry') {
      await page.evaluate(() =>
        (window as unknown as ProbeWindow).failPendingJump(),
      );
      await expect(pane.locator('.msg-window-result')).toContainText(
        'Cannot open this message',
      );
      await pane.getByRole('button', { name: 'Retry', exact: true }).click();
    } else {
      await page.evaluate(() => {
        const probe = window as unknown as ProbeWindow;
        const component = probe.ng.getComponent(
          document.querySelector('.pane-fg app-message-thread')!,
        ) as ThreadProbe;
        void component.onSearchJump(600);
      });
      // Superseding must settle the old caller before its I/O completes.
      await page.evaluate(() => (window as unknown as ProbeWindow).pendingJump);
    }
    await expect(pane.locator('app-message-window-skeleton')).toHaveCount(0);
    await expect(pane.locator('.msg-window-result')).toHaveCount(0);
    await expect(pane.locator('.msg-row').first()).toBeVisible();
    if (mode === 'replace') {
      await page.evaluate(async () => {
        (window as unknown as ProbeWindow).failPendingJump();
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    await expect(pane.locator('.msg-window-result')).toHaveCount(0);
    await expect(editor).toHaveText('retain draft across window replacement');
    expect(
      await page.evaluate(
        (target) => {
          const probe = window as unknown as ProbeWindow;
          const component = probe.ng.getComponent(
            document.querySelector('.pane-fg app-message-thread')!,
          ) as ThreadProbe;
          return {
            targetMounted:
              component.scroller.getMountedGeometry(target) !== null,
            sameKernel: component.scroller === probe.jumpSnapshot.kernel,
            sameBinding:
              component.lifecycle.binding === probe.jumpSnapshot.binding,
            sameComposer:
              document.querySelector('.pane-fg app-chat-input') ===
              probe.jumpSnapshot.composer,
            foreground: component.interactionActive(),
            replacedSources: probe.replacedSources,
          };
        },
        mode === 'retry' ? 400 : 600,
      ),
    ).toEqual({
      targetMounted: true,
      sameKernel: true,
      sameBinding: true,
      sameComposer: true,
      foreground: true,
      replacedSources: 1,
    });
  });
}
