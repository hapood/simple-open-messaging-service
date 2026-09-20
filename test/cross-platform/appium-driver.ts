import type { ElementSummary, Observation, PlatformDriver, TestAction } from './types.js';

interface AppiumElement { ELEMENT?: string; 'element-6066-11e4-a52e-4f735466cecf'?: string }

/** Minimal W3C WebDriver client. Keeping this small avoids coupling the test contract to WebdriverIO APIs. */
export class AndroidDriver implements PlatformDriver {
  readonly platform = 'android' as const;
  private sessionId?: string;
  private activeContext = 'NATIVE_APP';
  private readonly errors: string[] = [];

  constructor(private readonly serverUrl = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723') {}

  async open(url: string): Promise<void> {
    const response = await this.request('/session', 'POST', {
      capabilities: {
        alwaysMatch: {
          platformName: 'Android',
          'appium:automationName': 'UiAutomator2',
          'appium:appPackage': process.env.ANDROID_APP_PACKAGE ?? 'com.soms.client',
          'appium:appActivity': process.env.ANDROID_APP_ACTIVITY ?? '.MainActivity',
          'appium:noReset': process.env.ANDROID_NO_RESET !== '0',
          'appium:newCommandTimeout': 180,
        },
      },
    });
    this.sessionId = response.sessionId ?? response.value?.sessionId;
    if (!this.sessionId) throw new Error('Appium did not return a session id');
    // Tauri owns the WebView URL. Appium's URL command is only valid for browser contexts.
    if (url && this.activeContext.includes('WEBVIEW')) {
      await this.request(`/session/${this.sessionId}/url`, 'POST', { url });
    }
    await this.switchToWebViewIfAvailable();
  }

  async observe(): Promise<Observation> {
    const contexts = await this.contexts();
    const source = await this.request(`/session/${this.requiredSession()}/source`, 'GET');
    const pageText = String(source.value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 12_000);
    const elements = await this.visibleElements();
    return {
      platform: this.platform,
      contexts,
      activeContext: this.activeContext,
      pageText,
      elements,
      screenshotBase64: (await this.request(`/session/${this.requiredSession()}/screenshot`, 'GET')).value,
      recentErrors: this.errors.slice(-20),
    };
  }

  async act(action: Exclude<TestAction, { type: 'finish' }>): Promise<void> {
    switch (action.type) {
      case 'switchContext':
        await this.switchContext(action.context);
        return;
      case 'tap': {
        const element = await this.find(action.target);
        await this.request(`/session/${this.requiredSession()}/element/${element}/click`, 'POST', {});
        return;
      }
      case 'type': {
        const element = await this.find(action.target);
        await this.request(`/session/${this.requiredSession()}/element/${element}/clear`, 'POST', {});
        await this.request(`/session/${this.requiredSession()}/element/${element}/value`, 'POST', { text: action.text, value: [...action.text] });
        return;
      }
      case 'press':
        if (action.key === 'BACK') {
          await this.request('/session/' + this.requiredSession() + '/back', 'POST', {});
        } else {
          await this.request(`/session/${this.requiredSession()}/actions`, 'POST', { actions: [{ type: 'key', id: 'ai-test', actions: [{ type: 'keyDown', value: action.key === 'ENTER' ? '\uE007' : '\uE00C' }, { type: 'keyUp', value: action.key === 'ENTER' ? '\uE007' : '\uE00C' }] }] });
        }
        return;
      case 'scroll':
        await this.request(`/session/${this.requiredSession()}/actions`, 'POST', { actions: [{ type: 'pointer', id: 'ai-scroll', parameters: { pointerType: 'touch' }, actions: [{ type: 'pointerMove', x: 200, y: action.direction === 'down' ? 600 : 250 }, { type: 'pointerDown', button: 0 }, { type: 'pointerMove', x: 200, y: action.direction === 'down' ? 250 : 600, duration: action.amount ?? 400 }, { type: 'pointerUp', button: 0 }] }] });
        return;
      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
        return;
    }
  }

  async close(): Promise<void> {
    if (this.sessionId) await this.request(`/session/${this.sessionId}`, 'DELETE').catch(() => undefined);
    this.sessionId = undefined;
  }

  private async switchToWebViewIfAvailable() {
    const contexts = await this.contexts();
    const webview = contexts.find((context) => context.includes('WEBVIEW'));
    if (webview) await this.switchContextId(webview);
  }

  private async switchContext(kind: 'webview' | 'native') {
    const contexts = await this.contexts();
    const wanted = kind === 'native' ? 'NATIVE_APP' : contexts.find((context) => context.includes('WEBVIEW'));
    if (!wanted) throw new Error(`No ${kind} Appium context is available`);
    await this.switchContextId(wanted);
  }

  private async switchContextId(context: string) {
    await this.request(`/session/${this.requiredSession()}/context`, 'POST', { name: context });
    this.activeContext = context;
  }

  private async contexts(): Promise<string[]> {
    const result = await this.request(`/session/${this.requiredSession()}/contexts`, 'GET');
    return (result.value ?? []) as string[];
  }

  private async visibleElements(): Promise<ElementSummary[]> {
    const result = await this.request(`/session/${this.requiredSession()}/elements`, 'POST', { using: 'css selector', value: 'button,input,textarea,[contenteditable="true"]' });
    return Promise.all((result.value ?? []).slice(0, 100).map(async (element: AppiumElement) => {
      const id = element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT;
      const get = async (name: string) => (await this.request(`/session/${this.requiredSession()}/element/${id}/attribute/${name}`, 'GET')).value;
      return { id, name: await get('content-desc'), text: await get('text'), value: await get('value'), enabled: (await get('enabled')) !== 'false', visible: (await get('displayed')) !== 'false' };
    }));
  }

  private async find(target: string): Promise<string> {
    const strategy = target.startsWith('css=') ? 'css selector' : target.startsWith('id=') ? 'id' : 'accessibility id';
    const value = target.replace(/^(css|id)=/, '');
    const result = await this.request(`/session/${this.requiredSession()}/elements`, 'POST', { using: strategy, value });
    const element = result.value?.[0] as AppiumElement | undefined;
    const id = element?.['element-6066-11e4-a52e-4f735466cecf'] ?? element?.ELEMENT;
    if (!id) throw new Error(`AI target not found in ${this.activeContext}: ${target}`);
    return id;
  }

  private requiredSession(): string { if (!this.sessionId) throw new Error('Appium driver has not been opened'); return this.sessionId; }

  private async request(path: string, method: string, body?: unknown): Promise<any> {
    const response = await fetch(this.serverUrl.replace(/\/$/, '') + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || (json.value?.error && json.value.error !== '')) throw new Error(`Appium ${method} ${path}: ${JSON.stringify(json).slice(0, 500)}`);
    return json;
  }
}
