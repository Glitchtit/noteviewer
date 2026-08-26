import { useEffect, useRef } from 'react';
import type { VaultEvent } from '@noteviewer/shared';

export interface VaultEventHandlers {
  onTreeChanged(): void;
  onNoteChanged(path: string): void;
}

export function useVaultEvents(handlers: VaultEventHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let ev: VaultEvent;
      try {
        ev = JSON.parse(e.data) as VaultEvent;
      } catch {
        return;
      }
      if (ev.type === 'tree-changed') ref.current.onTreeChanged();
      else if (ev.type === 'note-changed') ref.current.onNoteChanged(ev.path);
    };
    return () => es.close();
  }, []);
}
