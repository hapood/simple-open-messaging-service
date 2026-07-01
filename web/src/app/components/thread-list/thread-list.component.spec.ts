import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ThreadListComponent } from './thread-list.component';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';

/**
 * thread-list 状态机防回归：重点覆盖原 `throw new Error(res.message)` 写在 RxJS
 * `next` 回调里被吞掉的 bug（接口 code!==0 / 网络失败时列表会永久卡空白）。
 *
 * 策略：手动触发 ngOnInit() + flush 列表接口，只断言 signal 状态——不 detectChanges，
 * 避开 EmptyState/UserAvatar 等子组件渲染与 Material 动画依赖。
 */
describe('ThreadListComponent 状态机', () => {
  let fixture: ComponentFixture<ThreadListComponent>;
  let comp: ThreadListComponent;
  let httpMock: HttpTestingController;
  let popupSpy: jasmine.Spy;

  beforeEach(() => {
    popupSpy = jasmine.createSpy('popupDlg');
    TestBed.configureTestingModule({
      imports: [ThreadListComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        { provide: RouteService, useValue: { popupDlg: popupSpy } },
      ],
    });
    fixture = TestBed.createComponent(ThreadListComponent);
    comp = fixture.componentInstance;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** 触发 ngOnInit（未首次 CD 时不会自动跑）并 flush 列表接口响应 */
  function flushList(res: { code: number; message?: string; data?: unknown[] }) {
    comp.ngOnInit();
    const req = httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid'));
    req.flush(res);
    return req;
  }

  it('code===0 空列表 → 加载完成，列表为空，无搜索词时不判搜索空', () => {
    flushList({ code: 0, data: [] });
    expect(comp.threadList()).toEqual([]);
    expect(comp.isSearchEmpty()).toBe(false);
  });

  it('code!==0 → 进入 ERROR 且不抛错（修复原 throw 被吞 bug）', () => {
    expect(() => flushList({ code: 1, message: '后端拒绝' })).not.toThrow();
    expect(comp.errorMsg()).toBe('后端拒绝');
  });

  it('HTTP 失败 → 进入 ERROR（原代码完全未覆盖网络错误路径）', () => {
    comp.ngOnInit();
    const req = httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid'));
    req.flush('network down', { status: 500, statusText: 'Server Error' });
    expect(comp.errorMsg()).toBe('Network error, please retry');
  });

  it('有搜索词且无匹配 → isSearchEmpty 为 true（搜索无结果态）', () => {
    flushList({ code: 0, data: [{ id: 1, type: 'P2P', peerUser: { uniqName: 'alice' } }] });
    fixture.componentRef.setInput('searchText', '不存在的人');
    expect(comp.isSearchEmpty()).toBe(true);
  });

  it('重试：ERROR 后再 genThreadList 会先清空 errorMsg 再重新请求', () => {
    flushList({ code: 1, message: 'x' });
    expect(comp.errorMsg()).toBe('x');
    comp.genThreadList();
    expect(comp.errorMsg()).toBe(''); // 已重置回 LOADING
    httpMock.expectOne(r => r.url.endsWith('/user/query-thread/valid')).flush({ code: 0, data: [] });
    expect(comp.threadList()).toEqual([]);
  });

  it('真空态 CTA：openFriendRequests → 调用 routeService.popupDlg', () => {
    comp.openFriendRequests();
    expect(popupSpy).toHaveBeenCalled();
  });
});
