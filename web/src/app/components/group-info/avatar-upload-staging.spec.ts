import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { GroupInfoComponent } from './group-info.component';
import { NewGroupComponent } from '../new-group/new-group.component';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService, PopupType } from '../../services/route.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { MemberProfileRepository } from '../../services/member-profile-store.service';
import { UserService } from '../../services/user.service';
import { ToastService } from '../../services/toast.service';
import { ContactCardShareService } from '../../services/contact-card-share.service';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { createGroupConversation } from '../../services/model';

type UploadResponse = { code: number; data?: { avatar: string } };

describe.each(['new', 'existing'] as const)(
  '%s group avatar staging',
  (kind) => {
    let component: NewGroupComponent | GroupInfoComponent;
    let uploads: Subject<UploadResponse>[];
    let crops: ((result: { file: File }) => void)[];
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;
    let createGroup: ReturnType<typeof vi.fn>;
    let updateGroup: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      uploads = [];
      crops = [];
      createObjectURL = vi
        .fn()
        .mockReturnValueOnce('blob:crop-1')
        .mockReturnValueOnce('blob:crop-2');
      revokeObjectURL = vi.fn();
      vi.stubGlobal(
        'URL',
        Object.assign(class extends URL {}, {
          createObjectURL,
          revokeObjectURL,
        }),
      );
      createGroup = vi.fn(() => of({ code: 0, data: { groupId: 7 } }));
      updateGroup = vi.fn(() => of({ code: 0 }));
      TestBed.configureTestingModule({
        providers: [
          ...[
            NavStateMachineService,
            UserService,
            MESSAGE_THREAD_ADAPTER,
            ContactCardShareService,
          ].map((provide) => ({ provide, useValue: {} })),
          { provide: GroupService, useValue: { createGroup, updateGroup } },
          { provide: ToastService, useValue: { warn: vi.fn() } },
          {
            provide: TranslocoService,
            useValue: { translate: (key: string) => key },
          },
          {
            provide: MemberProfileRepository,
            useValue: { queryPage: vi.fn().mockResolvedValue([]) },
          },
          {
            provide: ProfileNamespaceRepository,
            useValue: { resolve: () => of(null) },
          },
          {
            provide: ConversationListService,
            useValue: {
              openThreadId: signal(7),
              items: signal([
                createGroupConversation(
                  7,
                  {
                    id: 7,
                    account: '!team',
                    name: 'Team',
                    namespaceId: 0,
                  },
                  { role: 'ADMIN', profileRev: 4 },
                ),
              ]),
              load: vi.fn(),
              refreshAfterMutation: vi.fn(),
            },
          },
          {
            provide: RouteService,
            useValue: {
              closeDlg: vi.fn(),
              popupDlg: vi.fn(
                (
                  _type: PopupType,
                  _data: unknown,
                  callback: (result: { file: File }) => void,
                ) => {
                  crops.push(callback);
                },
              ),
            },
          },
          {
            provide: HttpClient,
            useValue: {
              post: vi.fn(() => {
                const pending = new Subject<UploadResponse>();
                uploads.push(pending);
                return pending;
              }),
            },
          },
        ],
      });
      component = TestBed.runInInjectionContext(() =>
        kind === 'new' ? new NewGroupComponent() : new GroupInfoComponent(),
      );
      if (component instanceof GroupInfoComponent) component.beginEdit();
      else component.name.set('Team');
    });

    afterEach(() => {
      component.ngOnDestroy();
      vi.unstubAllGlobals();
    });

    function pick(
      file = new File(['crop'], 'avatar.webp', { type: 'image/webp' }),
    ) {
      const input = {
        files: [file],
        value: 'selected',
      } as unknown as HTMLInputElement;
      component.pickAvatar(input);
      expect(input.value).toBe('');
      return () => crops.at(-1)!({ file });
    }

    function uploading() {
      return component instanceof NewGroupComponent
        ? component.avatarUploading()
        : component.busy();
    }

    function save() {
      if (component instanceof NewGroupComponent) component.confirm();
      else component.saveEdit();
    }

    it('previews cropped bytes locally and keeps the uploaded coordinate write-only', () => {
      pick()();
      expect(component.avatarPreviewUrl()).toBe('blob:crop-1');
      expect(component.pendingAvatar()).toBeUndefined();
      expect(uploading()).toBe(true);
      uploads[0].next({
        code: 0,
        data: { avatar: '/uploads/avatars/published.webp' },
      });
      uploads[0].complete();
      expect(component.pendingAvatar()).toBe('/uploads/avatars/published.webp');
      expect(component.avatarPreviewUrl()).toBe('blob:crop-1');
      expect(uploading()).toBe(false);
      if (component instanceof GroupInfoComponent)
        expect(component.groupProfileRef()?.rev).toBe(4);
    });

    it('cancels an earlier upload and revokes its preview before replacing it', () => {
      pick()();
      pick()();
      expect(uploads[0].observed).toBe(false);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:crop-1');
      expect(component.avatarPreviewUrl()).toBe('blob:crop-2');
      expect(uploading()).toBe(true);
      uploads[0].next({
        code: 0,
        data: { avatar: '/uploads/avatars/stale.webp' },
      });
      expect(component.pendingAvatar()).toBeUndefined();
      uploads[1].next({
        code: 0,
        data: { avatar: '/uploads/avatars/current.webp' },
      });
      uploads[1].complete();
      expect(component.pendingAvatar()).toBe('/uploads/avatars/current.webp');
    });

    it('clears the preview and staged write coordinate on upload failure', () => {
      pick()();
      uploads[0].error(new Error('network'));
      expect(component.avatarPreviewUrl()).toBeUndefined();
      expect(component.pendingAvatar()).toBeUndefined();
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:crop-1');
      expect(uploading()).toBe(false);
    });

    it('does not retain an earlier successful upload when its replacement fails', () => {
      pick()();
      uploads[0].next({
        code: 0,
        data: { avatar: '/uploads/avatars/old.webp' },
      });
      uploads[0].complete();
      pick()();
      uploads[1].next({ code: 10000 });
      uploads[1].complete();
      expect(component.pendingAvatar()).toBeUndefined();
      expect(component.avatarPreviewUrl()).toBeUndefined();
      expect(revokeObjectURL.mock.calls).toEqual([
        ['blob:crop-1'],
        ['blob:crop-2'],
      ]);
    });

    it('cancels upload and releases its preview exactly once when destroyed', () => {
      pick()();
      component.ngOnDestroy();
      expect(uploads[0].observed).toBe(false);
      expect(component.avatarPreviewUrl()).toBeUndefined();
      expect(component.pendingAvatar()).toBeUndefined();
      component.ngOnDestroy();
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:crop-1');
    });

    it('ignores cropper completion after the owner has been destroyed', () => {
      const finishCrop = pick();
      component.ngOnDestroy();
      finishCrop();
      expect(uploads).toHaveLength(0);
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('does not publish while the avatar upload is pending', () => {
      pick()();
      save();
      expect(createGroup).not.toHaveBeenCalled();
      expect(updateGroup).not.toHaveBeenCalled();
    });

    it('submits the server coordinate, never the local preview URL', () => {
      pick()();
      uploads[0].next({
        code: 0,
        data: { avatar: '/uploads/avatars/write.webp' },
      });
      uploads[0].complete();
      save();
      const command = kind === 'new' ? createGroup : updateGroup;
      expect(command).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Team',
          avatar: '/uploads/avatars/write.webp',
        }),
      );
      component.ngOnDestroy();
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:crop-1');
    });

    if (kind === 'existing') {
      it('cancels pending uploads when editing is cancelled', () => {
        pick()();
        (component as GroupInfoComponent).cancelEdit();
        expect(uploads[0].observed).toBe(false);
        expect(uploading()).toBe(false);
        expect(component.pendingAvatar()).toBeUndefined();
        expect(component.avatarPreviewUrl()).toBeUndefined();
      });
    }
  },
);
