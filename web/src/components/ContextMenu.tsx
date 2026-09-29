import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  onSelect(): void;
  danger?: boolean;
  /** Ask for a second click (label replaced by confirmLabel) before onSelect runs. */
  confirmLabel?: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose(): void;
}

/**
 * A floating menu at (x, y), clamped to the viewport. Closes on outside
 * pointer-down, Escape, scroll, resize or after an item is chosen.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [confirming, setConfirming] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        buttons[(next + buttons.length) % buttons.length]?.focus();
      }
    }
    // Capture phase so scrolls inside any container (the sidebar) close it too.
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Portalled to <body>: the mobile sidebar is transformed, which would make
  // position: fixed relative to it instead of the viewport.
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          onClick={() => {
            if (item.confirmLabel && confirming !== i) {
              setConfirming(i);
              return;
            }
            onClose();
            item.onSelect();
          }}
        >
          {confirming === i && item.confirmLabel ? item.confirmLabel : item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
