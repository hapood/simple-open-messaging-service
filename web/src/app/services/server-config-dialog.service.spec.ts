import { ServerConfigDialogService } from './server-config-dialog.service';

describe('ServerConfigDialogService', () => {
  it('opens and closes the optional reconfiguration dialog', () => {
    const service = new ServerConfigDialogService();

    expect(service.visible()).toBeFalse();
    service.open();
    expect(service.visible()).toBeTrue();
    service.close();
    expect(service.visible()).toBeFalse();
  });
});
