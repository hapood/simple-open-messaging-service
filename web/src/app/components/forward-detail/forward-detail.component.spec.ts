import { signal } from '@angular/core';
import { ForwardDetailComponent } from './forward-detail.component';
import type {
  ForwardManifestMessage,
  ForwardWireBundle,
} from './forward-bundle.model';

// Exercise the display projection without mounting the modal or its injected services.
describe('forward reply display', () => {
  const original: ForwardManifestMessage = {
    id: 1,
    profile: { displayName: 'alice' },
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
  it('renders equal display names as independent snapshots', () => {
    const first = project(original);
    const second = project(reply());
    expect(first.type).toBe('msg');
    expect(second.type).toBe('msg');
    if (first.type !== 'msg' || second.type !== 'msg') {
      throw new Error('expected ordinary snapshot rows');
    }
    expect(first.name).toBe('alice');
    expect(second.name).toBe('alice');
    expect(first.senderDisplayContext).toBe('forward');
    expect(second.senderDisplayContext).toBe('forward');
    expect(first.isGroupConversation).toBeUndefined();
    expect(second.isGroupConversation).toBeUndefined();
    expect(first.creator).toBe(JSON.stringify(['bundle', 1]));
    expect(second.creator).toBe(JSON.stringify(['bundle', 2]));
    expect(first.avatarIdentityId).toBe(first.creator);
    expect(second.avatarIdentityId).toBe(second.creator);
    expect(first.sender?.kind).toBe('forward');
    expect(first.sender).toEqual({
      kind: 'forward',
      name: 'alice',
      imageUrl: null,
    });
  });
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

describe('forward nested card projection', () => {
  it('counts shared nested children for every reference without duplicating bodies', () => {
    const card = (
      id: number,
      childBundleId: string,
    ): ForwardManifestMessage => ({
      id,
      profile: { displayName: 'Alice' },
      contentType: 'FORWARD',
      content: JSON.stringify({ bundleId: childBundleId }),
      sentAt: 1,
      childBundleId,
    });
    const leaf: ForwardManifestMessage = {
      id: 1,
      profile: { displayName: 'Bob' },
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 2,
    };
    const message = card(1, 'child');
    const closure: ForwardWireBundle = {
      id: 'root',
      messages: [message],
      children: [
        { id: 'child', messages: [card(1, 'leaf'), card(2, 'leaf')] },
        { id: 'leaf', messages: [leaf] },
      ],
      assets: [],
      accessContext: { threadId: 42, seq: 7 },
    };
    const component = Object.create(
      ForwardDetailComponent.prototype,
    ) as ForwardDetailComponent;
    Object.assign(component, { closure: signal(closure) });
    const data = component['toMsgData'](message, 1, closure);
    expect(JSON.parse(data.text).messageCount).toBe(4);
    expect(JSON.parse(data.text).summaryLines).toHaveLength(2);
    expect(closure.children).toHaveLength(2);
  });

  it('rebuilds a local card from a wire-only nested forward reference', () => {
    const message: ForwardManifestMessage = {
      id: 1,
      profile: { displayName: 'Alice' },
      contentType: 'FORWARD',
      content: JSON.stringify({ bundleId: 'child' }),
      sentAt: 1,
      childBundleId: 'child',
    };
    const childMessage: ForwardManifestMessage = {
      id: 1,
      profile: { displayName: 'Bob' },
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'hello' }),
      sentAt: 2,
    };
    const closure: ForwardWireBundle = {
      id: 'root',
      messages: [message],
      children: [{ id: 'child', messages: [childMessage] }],
      assets: [],
      accessContext: { threadId: 42, seq: 7 },
    };
    const component = Object.create(
      ForwardDetailComponent.prototype,
    ) as ForwardDetailComponent;
    Object.assign(component, { closure: signal(closure) });

    const data = component['toMsgData'](message, 1, closure);

    expect(JSON.parse(data.text)).toEqual({
      bundleId: 'child',
      summaryLines: ['Bob：hello'],
      messageCount: 1,
    });
  });
});

describe('forward snapshot avatar', () => {
  const digest = 'a'.repeat(64);
  const message: ForwardManifestMessage = {
    id: 1,
    profile: { displayName: 'Alice', avatarDigest: digest },
    contentType: 'PURE_TEXT',
    content: '{"text":"hello"}',
    sentAt: 1,
  };
  const bundle: ForwardWireBundle = {
    id: 'bundle',
    messages: [message],
    children: [],
    assets: [{ digest, bytes: 3268 }],
    accessContext: { threadId: 42, seq: 7 },
  };
  function project(closure: ForwardWireBundle) {
    const component = Object.create(
      ForwardDetailComponent.prototype,
    ) as ForwardDetailComponent;
    Object.assign(component, { closure: signal(closure) });
    const item = component['toMsgData'](message, 1, closure);
    if (item.sender?.kind !== 'forward')
      throw new Error('expected forward source');
    return item.sender.imageUrl;
  }

  it('resolves an avatar by digest from the wire asset descriptors', () => {
    expect(project(bundle)).toBe(
      `/uploads/msg-assets/aa/aa/${digest}?threadId=42&seq=7`,
    );
  });

  it('falls back when the snapshot has no matching asset', () => {
    expect(project({ ...bundle, assets: [] })).toBeNull();
  });
});
