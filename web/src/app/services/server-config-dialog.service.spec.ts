import { ServerConfigDialogService } from './server-config-dialog.service';

describe('ServerConfigDialogService', () => {
  it('opens and closes the optional reconfiguration dialog', () => {
    const service = new ServerConfigDialogService();

    expect(service.visible()).toBe(false);
    service.open();
    expect(service.visible()).toBe(true);
    service.close();
    expect(service.visible()).toBe(false);
  });
});
