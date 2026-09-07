import { signal } from '@angular/core';
import { ForwardDetailComponent } from './forward-detail.component';
import type { ForwardManifestMessage } from './forward-bundle.model';

// Exercise the display projection without mounting the modal or its injected services.
describe('forward reply display', () => {
  const original: ForwardManifestMessage = {
    id: 1,
    author: { account: 'alice', domain: 'example.test' },
    contentType: 'PURE_TEXT',
    content: '{"text":"original"}',
    sentAt: 1,
  };
  const reply = (seq?: number): ForwardManifestMessage => ({
    ...original,
    id: 2,
    content: '{"text":"reply"}',
    ...(seq === undefined ? {} : { quoteTargetId: seq }),
  });
  function project(message: ForwardManifestMessage) {
    const component = Object.create(
      ForwardDetailComponent.prototype,
    ) as ForwardDetailComponent;
    Object.assign(component, { closure: signal(null) });
    return component['toMsgData'](message, 2, {
      id: 'bundle',
      messages: [original, message],
    });
  }
  it('preserves an absent quote without enabling navigation', () => {
    expect(project(reply(0)).quote).toEqual({ seq: 0, status: 'NOT_FOUND' });
  });
  it('resolves a selected target in the enclosing bundle', () => {
    expect(project(reply(1)).quote).toEqual({
      seq: 1,
      author: 'alice',
      body: 'original',
    });
  });
  it('displays an unresolved positive reference as unavailable', () => {
    expect(project(reply(99)).quote).toEqual({ seq: 0, status: 'NOT_FOUND' });
  });
  it('keeps ordinary text distinct from an absent quote', () => {
    expect(project(reply()).quote).toBeUndefined();
  });
});
