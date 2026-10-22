import { TestBed } from '@angular/core/testing';
import { PopupType, RouteService } from './route.service';
import {
  ExternalLinkService,
  externalLinkPolicy,
} from './external-link.service';

describe('external link navigation policy', () => {
  it('opens web links directly and blocks executable and local-resource schemes', () => {
    expect(externalLinkPolicy('https://example.com/a')).toBe('open');
    expect(externalLinkPolicy('http://example.com/a')).toBe('open');
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      'blob:https://example.com/id',
      'content://provider/id',
      'not a url',
    ]) {
      expect(externalLinkPolicy(target)).toBe('block');
    }
    expect(externalLinkPolicy('mailto:alice@example.com')).toBe('confirm');
    expect(externalLinkPolicy('tel:+1234567890')).toBe('confirm');
  });

  it('requires an affirmative dialog result before invoking an external handler', async () => {
    const popupDlg = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: RouteService, useValue: { popupDlg } }],
    });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      const service = TestBed.inject(ExternalLinkService);
      await service.open('https://example.com');
      expect(open).toHaveBeenCalledWith(
        'https://example.com',
        '_blank',
        'noopener,noreferrer',
      );
      open.mockClear();

      await service.open('mailto:alice@example.com');
      expect(open).not.toHaveBeenCalled();
      expect(popupDlg).toHaveBeenCalledWith(
        PopupType.CONFIRM,
        expect.objectContaining({
          messageParams: { scheme: 'mailto', url: 'mailto:alice@example.com' },
        }),
        expect.any(Function),
      );
      const onResult = popupDlg.mock.calls[0][2] as (
        result: boolean | undefined,
      ) => void;
      onResult(false);
      onResult(undefined);
      expect(open).not.toHaveBeenCalled();
      onResult(true);
      expect(open).toHaveBeenCalledWith(
        'mailto:alice@example.com',
        '_blank',
        'noopener,noreferrer',
      );

      popupDlg.mockClear();
      open.mockClear();
      await service.open('javascript:alert(1)');
      expect(popupDlg).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
