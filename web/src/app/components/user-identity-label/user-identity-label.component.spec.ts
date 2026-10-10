import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { UserIdentityLabelComponent } from './user-identity-label.component';

const profile: ResolvedProfile = {
  publisherNamespaceId: 0,
  namespaceId: 0,
  account: 'alice',
  rev: 7,
  name: 'Alice',
  bio: '',
  avatarDigest: null,
  avatarBlob: null,
};

function createLabel() {
  const resolution = new Subject<ResolvedProfile>();
  const resolve = vi.fn(() => resolution);
  TestBed.configureTestingModule({
    imports: [UserIdentityLabelComponent],
    providers: [{ provide: ProfileRepository, useValue: { resolve } }],
  });
  const fixture = TestBed.createComponent(UserIdentityLabelComponent);
  fixture.componentRef.setInput('account', 'alice');
  fixture.componentRef.setInput('domain', 'alpha.test');
  return { fixture, resolution, resolve };
}

describe('UserIdentityLabelComponent', () => {
  it('resolves the selected profile name and retains the real local domain', () => {
    const { fixture, resolution, resolve } = createLabel();
    const demand = {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 7 },
    };
    fixture.componentRef.setInput('profileEvidence', demand);
    fixture.detectChanges();
    expect(fixture.componentInstance.effectiveName()).toBe('alice');
    expect(resolve).toHaveBeenCalledWith(demand);
    resolution.next(profile);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.identity-name').textContent.trim(),
    ).toBe('Alice');
    expect(
      fixture.nativeElement
        .querySelector('.identity-domain')
        .textContent.trim(),
    ).toBe('alpha.test');
    resolution.error(new Error('unavailable'));
    fixture.detectChanges();
    expect(fixture.componentInstance.effectiveName()).toBe('alice');
  });

  it('uses an already-resolved search profile without requesting another profile', () => {
    const { fixture, resolve } = createLabel();
    fixture.componentRef.setInput('profile', profile);
    fixture.detectChanges();
    expect(fixture.componentInstance.effectiveName()).toBe('Alice');
    expect(resolve).not.toHaveBeenCalled();
  });
});
