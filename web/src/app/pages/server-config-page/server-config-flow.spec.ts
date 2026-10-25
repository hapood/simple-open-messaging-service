import { TestBed } from '@angular/core/testing';
import { ServerConfigPageComponent } from './server-config-page.component';
import { RouteService } from '../../services/route.service';
import { ConfigService } from '../../services/config.service';
import { PushService } from '../../services/push.service';
import { AppBackDispatcherService } from '../../services/app-back-dispatcher.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Exercise the page's actual RxJS subscriptions, not a separately reconstructed operator chain. */
describe('ServerConfigPage flow', () => {
  const invoke =
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >();
  const saved = {
    origins: { primary: 'https://server.example', secondary: null },
    active: 'https://server.example',
  };
  let admission: ReturnType<typeof deferred<string>>;
  let verification: ReturnType<typeof deferred<object>>;
  let commit: ReturnType<typeof deferred<typeof saved>>;

  beforeEach(async () => {
    admission = deferred<string>();
    verification = deferred<object>();
    commit = deferred<typeof saved>();
    invoke.mockReset().mockImplementation((command) => {
      switch (command) {
        case 'begin_server_setup':
          return admission.promise;
        case 'check_server_setup':
          return verification.promise;
        case 'commit_server_setup':
          return commit.promise;
        case 'cancel_server_setup':
          return Promise.resolve();
        default:
          return Promise.reject(new Error(`unexpected command: ${command}`));
      }
    });
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    await TestBed.configureTestingModule({
      imports: [ServerConfigPageComponent],
      providers: [
        { provide: RouteService, useValue: { redirect: vi.fn() } },
        { provide: ConfigService, useValue: { reload: vi.fn() } },
        { provide: PushService, useValue: { applyFirebaseConfig: vi.fn() } },
        {
          provide: AppBackDispatcherService,
          useValue: { register: () => () => {} },
        },
      ],
    })
      .overrideComponent(ServerConfigPageComponent, {
        set: { template: '', imports: [] },
      })
      .compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    vi.restoreAllMocks();
  });

  function page() {
    const fixture = TestBed.createComponent(ServerConfigPageComponent);
    fixture.componentRef.setInput('dialog', true);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const closed = vi.fn();
    component.closed.subscribe(closed);
    component.url.setValue('https://entered.example');
    component.save();
    return { fixture, component, closed };
  }
  async function verify() {
    admission.resolve('setup-1');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('check_server_setup', {
        id: 'setup-1',
        origin: 'https://entered.example',
      }),
    );
  }
  const commands = () => invoke.mock.calls.map(([command]) => command);

  it('cancels a late admission after dismissal without starting verification', async () => {
    const { component, closed } = page();
    component.goBack();
    expect(closed).toHaveBeenCalledTimes(1);
    admission.resolve('setup-1');
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cancel_server_setup', {
        id: 'setup-1',
      }),
    );
    expect(commands()).not.toContain('check_server_setup');
    expect(commands()).not.toContain('commit_server_setup');
  });

  it('cancels verification on destruction and ignores its late response', async () => {
    const { fixture } = page();
    await verify();
    fixture.destroy();
    verification.resolve({ primaryOrigin: 'https://server.example' });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cancel_server_setup', {
        id: 'setup-1',
      }),
    );
    expect(commands()).not.toContain('commit_server_setup');
  });

  it('cancels while waiting for pair confirmation and cannot later commit', async () => {
    const { component } = page();
    await verify();
    verification.resolve({
      primaryOrigin: 'https://server.example',
      lanOrigin: 'https://lan.example',
    });
    await vi.waitFor(() => expect(component.autoFill()).not.toBeNull());
    component.goBack();
    component.confirmAutoFill();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cancel_server_setup', {
        id: 'setup-1',
      }),
    );
    expect(commands()).not.toContain('commit_server_setup');
  });

  it('commits once and blocks dismissal, escape, and duplicate submission', async () => {
    const { component, closed } = page();
    await verify();
    verification.resolve({ primaryOrigin: 'https://server.example' });
    await vi.waitFor(() => expect(component.saving()).toBe(true));
    component.goBack();
    component.onEscape(new Event('keydown'));
    component.save();
    expect(closed).not.toHaveBeenCalled();
    expect(
      commands().filter((command) => command === 'commit_server_setup'),
    ).toHaveLength(1);
    expect(commands()).not.toContain('cancel_server_setup');
    commit.resolve(saved);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });

  it('allows retry after a commit failure without retaining a pending operation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { component } = page();
    await verify();
    verification.resolve({ primaryOrigin: 'https://server.example' });
    await vi.waitFor(() => expect(component.saving()).toBe(true));
    commit.reject(new Error('login is in progress'));
    await vi.waitFor(() => expect(component.busy()).toBe(false));
    expect(component.errorDetail()).toBe('login is in progress');
    component.save();
    expect(
      commands().filter((command) => command === 'begin_server_setup'),
    ).toHaveLength(2);
  });
});
