import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { ConfigService, LoginMode } from './config.service';

describe('ConfigService connection cancellation', () => {
  it('unsubscribes the active config request and waits for an explicit retry', async () => {
    let requestCancelled = false;
    const pending = new Observable(() => () => {
      requestCancelled = true;
    });
    const http = {
      get: jasmine.createSpy('get').and.returnValues(
        pending,
        of({
          code: 0,
          message: 'ok',
          data: { registrationOpen: true, loginMode: LoginMode.ALL },
        }),
      ),
    } as Pick<HttpClient, 'get'>;
    const service = new ConfigService(http as HttpClient);

    const abandoned = service.ensureLoaded();

    service.cancelLoad();
    await abandoned;

    expect(requestCancelled).toBeTrue();
    expect(service.loaded()).toBeTrue();
    expect(service.cancelled()).toBeTrue();
    expect(service.loginMode()).toBeNull();

    await service.ensureLoaded();
    expect(http.get).toHaveBeenCalledTimes(1);

    await service.reload();

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(service.cancelled()).toBeFalse();
    expect(service.loginMode()).toBe(LoginMode.ALL);
  });
});
