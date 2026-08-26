import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVaultEvents } from '../src/hooks/useVaultEvents';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('useVaultEvents', () => {
  it('connects once and dispatches events to the handlers', () => {
    const onTreeChanged = vi.fn();
    const onNoteChanged = vi.fn();
    const hook = renderHook(() => useVaultEvents({ onTreeChanged, onNoteChanged }));
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/events');
    es.onmessage!({ data: JSON.stringify({ type: 'tree-changed' }) });
    es.onmessage!({ data: JSON.stringify({ type: 'note-changed', path: 'a.md' }) });
    es.onmessage!({ data: 'not json' });
    expect(onTreeChanged).toHaveBeenCalledOnce();
    expect(onNoteChanged).toHaveBeenCalledWith('a.md');
    hook.rerender();
    expect(FakeEventSource.instances).toHaveLength(1);
    hook.unmount();
    expect(es.closed).toBe(true);
  });

  it('uses the latest handlers after re-render', () => {
    let seen = '';
    const hook = renderHook(
      ({ tag }: { tag: string }) =>
        useVaultEvents({ onTreeChanged: () => { seen = tag; }, onNoteChanged: () => {} }),
      { initialProps: { tag: 'first' } },
    );
    hook.rerender({ tag: 'second' });
    FakeEventSource.instances[0]!.onmessage!({ data: JSON.stringify({ type: 'tree-changed' }) });
    expect(seen).toBe('second');
  });
});
