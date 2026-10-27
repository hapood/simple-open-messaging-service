import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import {
  IdentitySearch,
  IdentitySearchStatus,
} from '../../services/identity-search';
import { UserService } from '../../services/user.service';
import { IdentitySearchComponent } from './identity-search.component';

describe('IdentitySearchComponent', () => {
  async function create() {
    TestBed.configureTestingModule({
      imports: [IdentitySearchComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideTransloco({
          config: { availableLangs: ['zh-CN'], defaultLang: 'zh-CN' },
          loader: InlineTranslocoLoader,
        }),
        {
          provide: UserService,
          useValue: { resolveUser: () => of({ code: 1 }) },
        },
      ],
    });
    const lookup = TestBed.runInInjectionContext(() => new IdentitySearch());
    const fixture = TestBed.createComponent(IdentitySearchComponent);
    fixture.componentRef.setInput('lookup', lookup);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, lookup, element: fixture.nativeElement as HTMLElement };
  }

  it('renders the shared exact-account copy and emits one submit', async () => {
    const { fixture, element } = await create();
    expect(element.textContent).toContain('查找你的好友');
    expect(element.textContent).toContain('精确输入账号');
    const input = element.querySelector('input')!;
    expect(input.placeholder).toBe('输入完整账号或账号@域名');
    const submitted = vi.fn();
    fixture.componentInstance.submitted.subscribe(submitted);
    input.value = 'alice@peer.test';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fixture.componentInstance.text()).toBe('alice@peer.test');
    expect(submitted).toHaveBeenCalledOnce();
  });

  it('offers cancellation even before federation progress and retry after failure', async () => {
    const { fixture, lookup, element } = await create();
    const cancelled = vi.fn();
    const submitted = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.componentInstance.submitted.subscribe(submitted);
    lookup.status.set(IdentitySearchStatus.SEARCHING);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(element.querySelector('input')!.disabled).toBe(true);
    element
      .querySelector<HTMLButtonElement>('.connecting-progress button')!
      .click();
    expect(cancelled).toHaveBeenCalledOnce();
    lookup.errorKey.set('friend.error.timeout');
    lookup.status.set(IdentitySearchStatus.ERROR);
    fixture.detectChanges();
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    element.querySelector<HTMLButtonElement>('.state-hint button')!.click();
    expect(submitted).toHaveBeenCalledOnce();
  });
});
