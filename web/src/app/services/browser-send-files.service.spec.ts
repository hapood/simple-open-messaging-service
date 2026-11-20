import { TestBed } from '@angular/core/testing';
import { BrowserSendFiles, SendAttachmentUnavailableError } from './browser-send-files.service';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('browser runtime attachment references', () => {
  it('stores only metadata in descriptors and retains the File for live retries', () => {
    const owner = TestBed.inject(BrowserSendFiles);
    const file = new File(['data'], 'file.bin', { type: 'application/x-custom' });
    const descriptor = owner.retain(file, 'original-part');
    expect(descriptor).toMatchObject({ partId: 'original-part', name: 'file.bin', size: 4, mimeType: 'application/x-custom' });
    expect(Object.hasOwn(descriptor, 'blob')).toBe(false);
    expect(owner.resolve(descriptor)).toBe(file);
    owner.release(descriptor.path);
    expect(() => owner.resolve(descriptor)).toThrow(SendAttachmentUnavailableError);
  });

  it('cannot resolve a reference after runtime/session resources are released', () => {
    const owner = TestBed.inject(BrowserSendFiles);
    const descriptor = owner.retain(new File(['data'], 'file.bin'), 'part');
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(owner.bytes()).toBe(0);
    expect(() => owner.resolve(descriptor)).toThrow('Please cancel and upload again');
  });
});
