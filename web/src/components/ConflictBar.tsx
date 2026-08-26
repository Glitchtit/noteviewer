export interface ConflictBarProps {
  onTheirs(): void;
  onMine(): void;
  onCopy(): void;
}

export function ConflictBar({ onTheirs, onMine, onCopy }: ConflictBarProps) {
  return (
    <div className="conflict-bar" role="alert">
      <span>This note changed on disk while you were editing.</span>
      <div className="conflict-actions">
        <button onClick={onTheirs}>Load theirs</button>
        <button onClick={onMine}>Overwrite with mine</button>
        <button className="primary" onClick={onCopy}>Save as copy</button>
      </div>
    </div>
  );
}
