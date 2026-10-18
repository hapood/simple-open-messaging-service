import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideTransloco } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { ProfileRepository } from '../../services/profile-store.service';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { UserService } from '../../services/user.service';
import { AvatarComponent } from '../user-avatar/avatar.component';
import { FriendRequestCardComponent } from './friend-request-card.component';

describe('FriendRequestCardComponent sent snapshot', () => {
  it.each([null, 'data:image/png;base64,c2VudA=='])(
    'renders sent presentation without profile demand (avatar: %s)',
    async (avatar) => {
      const resolve = vi.fn(() => new Subject());
      TestBed.configureTestingModule({
        imports: [FriendRequestCardComponent],
        providers: [
          provideTransloco({
            config: { availableLangs: ['en'], defaultLang: 'en' },
            loader: InlineTranslocoLoader,
          }),
          { provide: ConversationListService, useValue: { items: () => [] } },
          { provide: ProfileRepository, useValue: { resolve } },
          {
            provide: UserService,
            useValue: { sessionProfile: () => undefined },
          },
          {
            provide: ProfileNamespaceRepository,
            useValue: {
              resolve: () => of({ domain: 'peer.test', status: 'ACTIVE' }),
            },
          },
        ],
      });
      const fixture = TestBed.createComponent(FriendRequestCardComponent);
      fixture.componentRef.setInput('direction', 'OUTGOING');
      fixture.componentRef.setInput('relativeDate', 'today');
      fixture.componentRef.setInput('requestItem', {
        id: 'request',
        account: 'bob',
        namespaceId: 7,
        status: 'REJECTED',
        date: 1,
        errText: '',
        profileRev: 0,
        snapshot: { displayName: 'Sent Bob', avatar },
      });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(
        fixture.nativeElement
          .querySelector('.identity-name')
          .textContent.trim(),
      ).toBe('Sent Bob');
      expect(
        fixture.nativeElement
          .querySelector('.identity-domain')
          .textContent.trim(),
      ).toBe('peer.test');
      const renderedAvatar = fixture.debugElement.query(
        By.directive(AvatarComponent),
      ).componentInstance as AvatarComponent;
      expect(renderedAvatar.imgSrc()).toBe(avatar ?? '');
      expect(renderedAvatar.effectiveName()).toBe('Sent Bob');
      expect(fixture.componentInstance.avatarProfile()).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
      renderedAvatar.imgFailed.set(true);
      fixture.detectChanges();
      expect(renderedAvatar.showImage()).toBe(false);
      expect(renderedAvatar.initial()).toBe('SB');
      expect(resolve).not.toHaveBeenCalled();
    },
  );
});
