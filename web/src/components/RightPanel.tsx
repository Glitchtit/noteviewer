import type { Heading } from '@noteviewer/shared';

export interface RightPanelProps {
  backlinks: string[];
  headings: Heading[];
  onOpenNote(path: string): void;
  onJumpToHeading(h: Heading): void;
}

export function RightPanel({ backlinks, headings, onOpenNote, onJumpToHeading }: RightPanelProps) {
  return (
    <aside className="right-panel">
      <h3>Backlinks</h3>
      {backlinks.length === 0 && <div className="panel-empty">No backlinks</div>}
      {backlinks.map((b) => (
        <button key={b} className="panel-item" onClick={() => onOpenNote(b)}>
          {b}
        </button>
      ))}
      <h3>Outline</h3>
      {headings.length === 0 && <div className="panel-empty">No headings</div>}
      {headings.map((h, i) => (
        <button
          key={`${h.level}-${h.text}-${i}`}
          className="panel-item"
          style={{ paddingLeft: `${8 + (h.level - 1) * 12}px` }}
          onClick={() => onJumpToHeading(h)}
        >
          {h.text}
        </button>
      ))}
    </aside>
  );
}
