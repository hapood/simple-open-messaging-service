import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslocoService } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { GroupService, GrpCreateInfo } from '../../services/group.service';
import { StandardResponse } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';
import { WebdbService, WebdbStorage } from '../../services/webdb.service';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { RouteService } from '../../services/route.service';
import { NewGroupComponent } from './new-group.component';
import { ToastService } from '../../services/toast.service';

describe('NewGroupComponent', () => {
  function createComponent() {
    TestBed.configureTestingModule({
      imports: [NewGroupComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ToastService, useValue: { warn: vi.fn() } },
        { provide: GroupService, useValue: { createGroup: vi.fn() } },
        { provide: RouteService, useValue: { closeDlg: vi.fn() } },
        {
          provide: ConversationListService,
          useValue: { items: signal([]) },
        },
        { provide: HttpClient, useValue: {} },
        { provide: WebdbService, useFactory: () => new WebdbStorage(() => null, new SessionLifecycleService()) as WebdbService },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return TestBed.createComponent(NewGroupComponent).componentInstance;
  }

  it('counts and limits group name and description by Unicode code points', () => {
    const component = createComponent();

    component.onNameInput('😀'.repeat(40));
    component.onDescInput('🧪'.repeat(300));

    expect(component.name()).toBe('😀'.repeat(31));
    expect(component.nameLength()).toBe(31);
    expect(component.description()).toBe('🧪'.repeat(240));
    expect(component.descriptionLength()).toBe(240);
  });

  it('allows only one create request while submission is pending', () => {
    const response = new Subject<StandardResponse<GrpCreateInfo>>();
    const groupService = { createGroup: vi.fn().mockReturnValue(response) };
    const routeService = { closeDlg: vi.fn() };
    TestBed.configureTestingModule({
      imports: [NewGroupComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ToastService, useValue: { warn: vi.fn() } },
        { provide: GroupService, useValue: groupService },
        { provide: RouteService, useValue: routeService },
        {
          provide: ConversationListService,
          useValue: { items: signal([]) },
        },
        { provide: HttpClient, useValue: {} },
        { provide: WebdbService, useFactory: () => new WebdbStorage(() => null, new SessionLifecycleService()) as WebdbService },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    const component =
      TestBed.createComponent(NewGroupComponent).componentInstance;
    component.name.set('Team');

    component.confirm();
    component.confirm();

    expect(groupService.createGroup).toHaveBeenCalledTimes(1);
    expect(groupService.createGroup).toHaveBeenCalledWith({
      name: 'Team',
      avatar: undefined,
      description: undefined,
    });
    expect(component.submitting()).toBe(true);
    response.next({ code: 10000, message: 'invalid' });
    response.complete();
    expect(component.submitting()).toBe(false);
    expect(routeService.closeDlg).not.toHaveBeenCalled();
  });
});
