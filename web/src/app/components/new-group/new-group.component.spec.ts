import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { Subject } from 'rxjs';
import { GroupService, GrpCreateInfo } from '../../services/group.service';
import { StandardResponse } from '../../services/model';
import { ConversationListService } from '../../services/conversation-list.service';
import { RouteService } from '../../services/route.service';
import { NewGroupComponent } from './new-group.component';

describe('NewGroupComponent', () => {
  it('allows only one create request while submission is pending', () => {
    const response = new Subject<StandardResponse<GrpCreateInfo>>();
    const groupService = { createGroup: jasmine.createSpy().and.returnValue(response) };
    const routeService = { closeDlg: jasmine.createSpy() };
    TestBed.configureTestingModule({
      imports: [NewGroupComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: GroupService, useValue: groupService },
        { provide: RouteService, useValue: routeService },
        { provide: ConversationListService, useValue: { items: signal([]), markTopOnNextUpdate: jasmine.createSpy() } },
        { provide: HttpClient, useValue: {} },
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
      ],
    });
    const component = TestBed.createComponent(NewGroupComponent).componentInstance;
    component.name.set('Team');

    component.confirm();
    component.confirm();

    expect(groupService.createGroup).toHaveBeenCalledTimes(1);
    expect(component.submitting()).toBeTrue();
    response.next({ code: 10000, message: 'invalid' });
    response.complete();
    expect(component.submitting()).toBeFalse();
    expect(routeService.closeDlg).not.toHaveBeenCalled();
  });
});
