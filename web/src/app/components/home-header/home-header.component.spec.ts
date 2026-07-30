import {
  computed,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../../i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../../i18n/transloco.loader';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  ImageDownloadService,
  type ImageDownloadTask,
} from '../../services/image-download.service';
import {
  MediaTransferService,
  type MediaTransferTask,
  type ThreadTransferSummary,
} from '../../services/media-transfer.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { RouteService } from '../../services/route.service';
import { ThemeService } from '../../services/theme.service';
import { UserService } from '../../services/user.service';
import { HomeHeaderComponent } from './home-header.component';

describe('HomeHeaderComponent — shared transfer progress', () => {
  const summaries = signal<ThreadTransferSummary[]>([]);
  const uploadTasks = signal<MediaTransferTask[]>([]);
  const downloadTasks = signal<ImageDownloadTask[]>([]);
  let imageDownloads: {
    tasks: typeof downloadTasks;
    activeCount: ReturnType<typeof computed<number>>;
    cancel: jasmine.Spy;
  };

  beforeEach(() => {
    summaries.set([]);
    uploadTasks.set([]);
    downloadTasks.set([]);
    imageDownloads = {
      tasks: downloadTasks,
      activeCount: computed(
        () =>
          downloadTasks().filter(
            (task) =>
              task.status === 'downloading' || task.status === 'saving',
          ).length,
      ),
      cancel: jasmine.createSpy('cancel'),
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTransloco({
          config: { availableLangs: ['en'], defaultLang: 'en' },
          loader: InlineTranslocoLoader,
        }),
        provideTranslocoTranspiler(CspSafeIcuTranspiler),
        {
          provide: RouteService,
          useValue: {
            openProfile: jasmine.createSpy('openProfile'),
            openSettings: jasmine.createSpy('openSettings'),
            popupDlg: jasmine.createSpy('popupDlg'),
          },
        },
        {
          provide: UserService,
          useValue: {
            friendReqBadge: signal(false),
            sessionProfile: signal(null),
          },
        },
        {
          provide: ThemeService,
          useValue: {
            mode: signal('system'),
            cycleMode: jasmine.createSpy('cycleMode'),
          },
        },
        {
          provide: ConversationListService,
          useValue: { items: signal([]) },
        },
        {
          provide: NavStateMachineService,
          useValue: { openChat: jasmine.createSpy('openChat') },
        },
        {
          provide: MediaTransferService,
          useValue: {
            summaries,
            tasks: uploadTasks,
            requestLatest: jasmine.createSpy('requestLatest'),
            cancel: jasmine.createSpy('cancel'),
            retry: jasmine.createSpy('retry'),
          },
        },
        { provide: ImageDownloadService, useValue: imageDownloads },
      ],
    });
  });

  it('combines upload and download bytes into one global percentage', () => {
    summaries.set([
      {
        threadId: 1,
        uploading: 1,
        completed: 0,
        failed: 0,
        total: 1,
        bytes: 100,
        loadedBytes: 25,
        progress: 25,
        latestAt: 1,
      },
    ]);
    downloadTasks.set([downloadTask('downloading', 175, 300)]);
    const component = create();

    expect(component.hasTransfers()).toBe(true);
    expect(component.transferProgress()).toBe(25);
    expect(component.downloadProgress()).toBe(58);
    expect(component.globalProgress()).toBe(50);
  });

  it('keeps completed loads out of the global menu while retaining failures', () => {
    downloadTasks.set([
      downloadTask('loaded', 300, 300),
      downloadTask('failed', 120, 300, '/uploads/failed.jpg'),
    ]);
    const component = create();

    expect(component.downloadTasks().map((task) => task.status)).toEqual([
      'failed',
    ]);
    expect(component.downloadFailedCount()).toBe(1);
    expect(component.downloadProgress()).toBeNull();
    expect(component.hasTransfers()).toBe(true);
  });

  it('cancels a download through the shared service using its message identity', () => {
    const task = downloadTask('downloading', 100, 300);
    downloadTasks.set([task]);
    const component = create();
    const event = new Event('click');
    spyOn(event, 'stopPropagation');

    component.cancelDownload(task.key, event);

    expect(event.stopPropagation).toHaveBeenCalled();
    expect(imageDownloads.cancel).toHaveBeenCalledWith({
      msgId: task.msgId,
      src: task.src,
    });
  });

  function create(): HomeHeaderComponent {
    return TestBed.createComponent(HomeHeaderComponent).componentInstance;
  }
});

function downloadTask(
  status: ImageDownloadTask['status'],
  loaded: number,
  total: number,
  src = '/uploads/photo.jpg',
): ImageDownloadTask {
  return {
    key: `42:${src}`,
    threadId: 7,
    msgId: 42,
    src,
    name: 'photo.jpg',
    expectedSize: total,
    loaded,
    total,
    status,
    saveAfterLoad: false,
    blobUrl: status === 'loaded' ? 'blob:photo' : null,
    startedAt: 1,
  };
}
