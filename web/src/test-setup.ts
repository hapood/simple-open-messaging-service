import 'fake-indexeddb/auto';
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { FormData as UndiciFormData } from 'undici';

class TestResizeObserver implements ResizeObserver {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

const matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  addListener: () => {},
  removeListener: () => {},
});

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});
Object.defineProperty(globalThis, 'Blob', {
  configurable: true,
  writable: true,
  value: NodeBlob,
});
Object.defineProperty(globalThis, 'File', {
  configurable: true,
  writable: true,
  value: NodeFile,
});
Object.defineProperty(globalThis, 'FormData', {
  configurable: true,
  writable: true,
  value: UndiciFormData,
});
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: matchMedia,
});

// jsdom exposes these browser APIs as "not implemented" placeholders that
// report errors whenever application cleanup or notification handling invokes
// them. Unit tests do not perform real window activation or media playback, so
// provide deterministic no-op implementations. Individual tests can still
// spy on or replace them when their calls are part of the behavior under test.
Object.defineProperty(window, 'focus', {
  configurable: true,
  writable: true,
  value: () => {},
});
Object.defineProperties(HTMLMediaElement.prototype, {
  load: {
    configurable: true,
    writable: true,
    value: () => {},
  },
  pause: {
    configurable: true,
    writable: true,
    value: () => {},
  },
});

if (!navigator.serviceWorker) {
  const serviceWorker = new EventTarget() as ServiceWorkerContainer;
  Object.assign(serviceWorker, {
    getRegistration: async () => undefined,
    getRegistrations: async () => [],
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: serviceWorker,
  });
}

if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:test-object-url';
  URL.revokeObjectURL = () => {};
}

if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
}
