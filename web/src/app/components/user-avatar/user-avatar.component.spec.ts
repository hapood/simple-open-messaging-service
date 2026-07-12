import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from './user-avatar.component';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { UserService } from '../../services/user.service';

describe('UserAvatarComponent (imgSrc branching)', () => {
  let fixture: ComponentFixture<UserAvatarComponent>;
  let getBlobSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UserAvatarComponent,
        { provide: UserService, useValue: { sessionProfile: signal<unknown>(undefined) } },
        {
          provide: AvatarRepository,
          useValue: { getBlob: jasmine.createSpy('getBlob').and.resolveTo(new Blob(['x'])) },
        },
      ],
    });
    fixture = TestBed.createComponent(UserAvatarComponent);
    getBlobSpy = TestBed.inject(AvatarRepository).getBlob as jasmine.Spy;
  });

  it('falls back to the initial letter when there is no src (no DB call)', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('name', 'Bob');
    fixture.componentRef.setInput('src', undefined);
    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('B');
    expect(getBlobSpy).not.toHaveBeenCalled();
  });

  it('passes a local-preview src (blob:/data:) straight through without the DB', () => {
    fixture.componentRef.setInput('identityId', 9);
    fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
    expect(fixture.componentInstance.imgSrc()).toBe('blob:http://localhost/abc');
    expect(getBlobSpy).not.toHaveBeenCalled();
  });

  it('renders nothing for a server-path avatar before the async DB resolve lands', () => {
    // A /uploads path goes through IDB (async); imgSrc is '' until the blob resolves → initial-letter.
    fixture.componentRef.setInput('identityId', 5);
    fixture.componentRef.setInput('src', '/uploads/avatars/g-512.webp');
    expect(fixture.componentInstance.imgSrc()).toBe('');
    expect(fixture.componentInstance.showImage()).toBe(false);
  });
});
