import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

const rect = {
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
} as DOMRect;

Range.prototype.getBoundingClientRect = () => rect;
Range.prototype.getClientRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: Array.prototype[Symbol.iterator] }) as unknown as DOMRectList;

if (!document.elementFromPoint) {
  (document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
}

// jsdom has no EventSource; App mounts one. Tests that care stub their own via vi.stubGlobal.
class StubEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  close(): void {}
}
if (!('EventSource' in globalThis)) {
  (globalThis as Record<string, unknown>).EventSource = StubEventSource;
}
