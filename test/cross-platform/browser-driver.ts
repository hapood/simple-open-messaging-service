import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { ElementSummary, Observation, PlatformDriver, TestAction } from './types.js';

export class BrowserDriver implements PlatformDriver {
  readonly platform = 'browser' as const;
  private context?: BrowserContext;
  private page?: Page;
  private readonly errors: string[] = [];

  constructor(private readonly browser: Browser) {}

  async open(url: string): Promise<void> {
    this.context = await this.browser.newContext({ ignoreHTTPSErrors: true });
    this.page = await this.context.newPage();
    this.page.on('console', (message) => message.type() === 'error' && this.errors.push(message.text()));
    this.page.on('pageerror', (error) => this.errors.push(error.message));
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  async observe(): Promise<Observation> {
    const page = this.requiredPage();
    const elements = await page.locator('button, input, textarea, [role], [contenteditable="true"]')
      .evaluateAll((nodes): ElementSummary[] => nodes.slice(0, 160).map((node) => {
        const element = node as HTMLElement;
        return {
          id: element.id || undefined,
          role: element.getAttribute('role') || element.tagName.toLowerCase(),
          name: element.getAttribute('aria-label') || element.getAttribute('name') || undefined,
          text: (element.innerText || element.getAttribute('placeholder') || '').trim().slice(0, 240),
          value: 'value' in element ? String((element as HTMLInputElement).value).slice(0, 240) : undefined,
          enabled: !(element as HTMLButtonElement).disabled,
          visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        };
      }));
    return {
      platform: this.platform,
      url: page.url(),
      title: await page.title(),
      pageText: (await page.locator('body').innerText()).slice(0, 12_000),
      elements,
      screenshotBase64: (await page.screenshot({ type: 'png' })).toString('base64'),
      recentErrors: this.errors.slice(-20),
    };
  }

  async act(action: Exclude<TestAction, { type: 'finish' }>): Promise<void> {
    const page = this.requiredPage();
    switch (action.type) {
      case 'tap':
        await this.resolve(action.target).click();
        return;
      case 'type':
        await this.resolve(action.target).fill(action.text);
        return;
      case 'press':
        if (action.key === 'BACK') {
          await page.goBack();
          return;
        }
        await page.keyboard.press(action.key === 'ESCAPE' ? 'Escape' : 'Enter');
        return;
      case 'scroll':
        await page.mouse.wheel(0, (action.amount ?? 600) * (action.direction === 'up' ? -1 : 1));
        return;
      case 'wait':
        await page.waitForTimeout(action.milliseconds);
        return;
      case 'switchContext':
        return;
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
  }

  private resolve(target: string) {
    const page = this.requiredPage();
    if (target.startsWith('css=')) return page.locator(target.slice(4));
    if (target.startsWith('text=')) return page.getByText(target.slice(5), { exact: false }).first();
    if (target.startsWith('role=')) {
      const [role, name] = target.slice(5).split('|', 2);
      return page.getByRole(role as never, name ? { name, exact: false } : undefined).first();
    }
    return page.getByText(target, { exact: false }).first();
  }

  private requiredPage(): Page {
    if (!this.page) throw new Error('Browser driver has not been opened');
    return this.page;
  }
}
