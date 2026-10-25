import { Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { HttpClient } from '@angular/common/http';
import { provideTransloco } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { FriendInviteDialogComponent } from './friend-invite-dialog.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { ProfileRepository } from '../../services/profile-store.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { parseLoginSessionId } from '../../services/session/session-identity';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import type { ProfileUserRef } from '../../services/model';

@Component({ selector: 'app-demand-avatar', template: '' })
class DemandAvatarStub {
  readonly type = input<unknown>();
  readonly name = input<unknown>();
  readonly account = input<unknown>();
  readonly domainSource = input<unknown>();
  readonly profile = input<unknown>();
}
@Component({ selector: 'app-snapshot-avatar', template: '' })
class SnapshotAvatarStub {
  readonly type = input<unknown>();
  readonly name = input<unknown>();
  readonly account = input<unknown>();
  readonly domainSource = input<unknown>();
  readonly src = input<unknown>();
}
const user: ProfileUserRef = {
  id: 8,
  account: 'alice',
  namespaceId: 2,
  name: 'Alice',
  bio: 'Bio',
  isGroup: false,
  profile: {
    account: 'alice',
    publisherNamespaceId: 0,
    profileNamespaceId: 2,
    rev: 3,
    linked: true,
    groupAccount: '!team',
  },
};
const resolved = {
  name: 'Published Alice',
  avatarBlob: new Blob(['x'], { type: 'image/png' }),
};

describe('FriendInviteDialog profile references', () => {
  const resolve = vi.fn();
  const get = vi.fn();
  const requestRelationship = vi.fn();

  beforeEach(() => {
    resolve.mockReset().mockReturnValue(of(resolved));
    get.mockReset();
    requestRelationship.mockReset().mockReturnValue(of({ code: 0, data: {} }));
    TestBed.configureTestingModule({
      providers: [
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        { provide: HttpClient, useValue: { get } },
        { provide: RouteService, useValue: { closeDlg: vi.fn() } },
        { provide: UserService, useValue: { requestRelationship } },
        { provide: ProfileRepository, useValue: { resolve } },
      ],
    }).overrideComponent(FriendInviteDialogComponent, {
      remove: { imports: [DemandAvatarComponent, SnapshotAvatarComponent] },
      add: { imports: [DemandAvatarStub, SnapshotAvatarStub] },
    });
  });

  it('passes known identity refs to demand rendering, without producing a dialog avatar string', () => {
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    fixture.componentRef.setInput('user', user);
    fixture.detectChanges();
    const avatar = fixture.debugElement.query(By.directive(DemandAvatarStub));
    expect(avatar.componentInstance.profile()).toBe(user.profile);
    expect(
      fixture.debugElement.query(By.directive(SnapshotAvatarStub)),
    ).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('serializes the pinned profile only when freezing the outgoing request', async () => {
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    fixture.componentRef.setInput('user', user);
    fixture.componentInstance.note.set(' Hello ');
    fixture.componentInstance.send();
    await vi.waitFor(() =>
      expect(requestRelationship).toHaveBeenCalledTimes(1),
    );
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'GROUP_MEMBER_PROFILE',
      groupAccount: '!team',
      target: { account: 'alice', profileNamespaceId: 2, rev: 3 },
    });
    expect(requestRelationship).toHaveBeenCalledExactlyOnceWith({
      account: 'alice',
      namespaceId: 2,
      note: 'Hello',
      snapshot: {
        displayName: 'Published Alice',
        avatar: 'data:image/png;base64,eA==',
      },
    });
    expect(get).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('unsubscribes profile resolution when the session is invalidated', () => {
    const pending = new Subject<typeof resolved>();
    resolve.mockReturnValue(pending);
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    fixture.componentRef.setInput('user', user);
    fixture.componentInstance.send();
    expect(pending.observed).toBe(true);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(pending.observed).toBe(false);
    expect(fixture.componentInstance.sending()).toBe(false);
    pending.next(resolved);
    pending.complete();
    expect(requestRelationship).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('cancels a pending lookup avatar fetch when the dialog is destroyed', () => {
    const pending = new Subject<Blob>();
    get.mockReturnValue(pending);
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    const { profile: _profile, ...identity } = user;
    fixture.componentRef.setInput('user', {
      ...identity,
      avatar: '/uploads/avatar.png',
    });
    fixture.componentInstance.send();
    expect(pending.observed).toBe(true);
    fixture.destroy();
    expect(pending.observed).toBe(false);
    expect(requestRelationship).not.toHaveBeenCalled();
  });

  it('cancels the whole operation when the selected subject changes', () => {
    const pending = new Subject<typeof resolved>();
    resolve.mockReturnValue(pending);
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    fixture.componentRef.setInput('user', user);
    fixture.detectChanges();
    fixture.componentInstance.send();
    expect(pending.observed).toBe(true);
    fixture.componentRef.setInput('user', { ...user, account: 'bob' });
    fixture.detectChanges();
    expect(pending.observed).toBe(false);
    expect(fixture.componentInstance.sending()).toBe(false);
    expect(requestRelationship).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('cancels the outgoing HTTP subscription on session replacement, without publishing completion', () => {
    const pending = new Subject<unknown>();
    requestRelationship.mockReturnValue(pending);
    resolve.mockReturnValue(of({ name: 'Published Alice', avatarBlob: null }));
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    fixture.componentRef.setInput('user', user);
    const completed = vi.fn();
    fixture.componentInstance.completed.subscribe(completed);
    fixture.componentInstance.send();
    expect(pending.observed).toBe(true);
    TestBed.inject(SessionLifecycleService).bindSession(
      parseLoginSessionId('12345678-1234-4234-8234-123456789abc'),
    );
    expect(pending.observed).toBe(false);
    pending.next({ code: 0, data: {} });
    expect(completed).not.toHaveBeenCalled();
    expect(fixture.componentInstance.errorText()).toBe('');
    expect(fixture.componentInstance.sending()).toBe(false);
    fixture.destroy();
  });

  it('keeps endpoint display data distinct from known profile references', () => {
    const fixture = TestBed.createComponent(FriendInviteDialogComponent);
    const { profile: _profile, ...identity } = user;
    fixture.componentRef.setInput('user', {
      ...identity,
      avatar: 'data:image/png;base64,eA==',
    });
    fixture.detectChanges();
    expect(
      fixture.debugElement.query(By.directive(DemandAvatarStub)),
    ).toBeNull();
    expect(
      fixture.debugElement
        .query(By.directive(SnapshotAvatarStub))
        .componentInstance.src(),
    ).toBe('data:image/png;base64,eA==');
    fixture.destroy();
  });
});
