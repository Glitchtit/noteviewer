import { useState } from 'react';
import { type KanbanDoc, moveCardIn, parseKanban, serializeKanban } from '../kanban';

export interface KanbanBoardProps {
  content: string;
  onChange(md: string): void;
}

export function KanbanBoard({ content, onChange }: KanbanBoardProps) {
  const doc = parseKanban(content);
  const [drag, setDrag] = useState<{ col: number; item: number } | null>(null);

  function commit(next: KanbanDoc) {
    onChange(serializeKanban(next));
  }

  function cloneDoc(): KanbanDoc {
    return { ...doc, columns: doc.columns.map((c) => ({ ...c, items: [...c.items] })) };
  }

  function moveCard(toCol: number, toIndex: number) {
    if (!drag) return;
    const next = moveCardIn(doc, drag, { col: toCol, item: toIndex });
    setDrag(null);
    commit(next);
  }

  return (
    <div className="kanban">
      {doc.columns.map((col, ci) => (
        <div
          key={col.title}
          className="kanban-col"
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => moveCard(ci, col.items.length)}
        >
          <div className="kanban-col-title">{col.title}</div>
          {col.items.map((item, ii) => (
            <div
              key={`${item.text}-${ii}`}
              className="kanban-card"
              draggable
              onDragStart={() => setDrag({ col: ci, item: ii })}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.stopPropagation();
                moveCard(ci, ii);
              }}
            >
              {!item.plain && (
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => {
                    const next = cloneDoc();
                    next.columns[ci]!.items[ii] = { ...item, done: !item.done };
                    commit(next);
                  }}
                />
              )}
              <span className={item.done ? 'kanban-done' : ''}>{item.text}</span>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements[0] as HTMLInputElement;
              if (!input.value.trim()) return;
              const next = cloneDoc();
              next.columns[ci]!.items.push({ text: input.value.trim(), done: false });
              input.value = '';
              commit(next);
            }}
          >
            <input placeholder="Add card…" />
          </form>
        </div>
      ))}
    </div>
  );
}
