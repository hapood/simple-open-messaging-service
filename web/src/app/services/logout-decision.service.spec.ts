import { TestBed } from '@angular/core/testing';
import { LogoutDecisionService } from './logout-decision.service';
import { PopupType, RouteService } from './route.service';

describe('LogoutDecisionService', () => {
  let result: (value: boolean | undefined) => void;
  const popupDlg = vi.fn();

  beforeEach(() => {
    popupDlg.mockReset();
    popupDlg.mockImplementation((_type, _inputs, callback) => {
      result = callback;
      return { id: 1 };
    });
    TestBed.configureTestingModule({
      providers: [LogoutDecisionService, { provide: RouteService, useValue: { popupDlg } }],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('requires an explicit retry and explains an uncertain timeout', async () => {
    const pending = TestBed.inject(LogoutDecisionService).decide({ status: 'timedOut' });
    await vi.waitFor(() => expect(popupDlg).toHaveBeenCalledOnce());
    expect(popupDlg).toHaveBeenCalledWith(PopupType.CONFIRM, expect.objectContaining({
      messageKey: 'auth.logoutDecision.timeout',
      confirmKey: 'auth.logoutDecision.retry',
      cancelKey: 'auth.logoutDecision.localOnly',
    }), expect.any(Function), { disableClose: true });
    result(true);
    expect(await pending).toBe('retry');
  });

  it('returns local-only only for the explicit secondary action', async () => {
    const pending = TestBed.inject(LogoutDecisionService).decide({ status: 'httpFailure', status_code: 503 });
    await vi.waitFor(() => expect(popupDlg).toHaveBeenCalledOnce());
    result(false);
    expect(await pending).toBe('localOnly');
  });

  it('does not interpret navigation dismissal as consent to delete credentials', async () => {
    const pending = TestBed.inject(LogoutDecisionService).decide({ status: 'transportFailure' });
    const rejected = expect(pending).rejects.toThrow('credentials retained');
    await vi.waitFor(() => expect(popupDlg).toHaveBeenCalledOnce());
    result(undefined);
    await rejected;
  });
});
