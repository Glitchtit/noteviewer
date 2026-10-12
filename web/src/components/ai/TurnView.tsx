import { useEffect, useState } from 'react';
import { estimateCost, type AiTurn, type ChangeRecord, type TurnItem, type UndoResolution, type UndoResult } from '@noteviewer/shared';
import { renderMarkdown } from '../../md/render';

const TOOL_ICONS: Record<string, string> = {
  list: '📁',
  read: '📖',
  search: '🔍',
  grep: '🔎',
  links: '🔗',
  write: '📝',
  edit: '✏️',
  move: '↪️',
  delete: '🗑',
  web_search: '🌐',
  web_fetch: '🌐',
};

const OP_ICONS: Record<ChangeRecord['op'], string> = { create: '＋', write: '📝', edit: '✏️', move: '↪️', delete: '🗑' };

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function Markdown({ text, onOpenNote }: { text: string; onOpenNote(target: string): void }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(text).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return (
    <div
      className="ai-output reading-view"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a.internal-link');
        const target = a?.getAttribute('data-target');
        if (target) {
          e.preventDefault();
          onOpenNote(target);
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ItemView({ item, onOpenNote }: { item: TurnItem; onOpenNote(target: string): void }) {
  if (item.kind === 'text') return <Markdown text={item.text} onOpenNote={onOpenNote} />;
  if (item.kind === 'thinking') {
    return (
      <details className="ai-thinking">
        <summary>Thinking</summary>
        <div className="ai-thinking-text">{item.text}</div>
      </details>
    );
  }
  const label = item.summary ?? `${item.name}…`;
  const icon = TOOL_ICONS[item.name] ?? '🔧';
  const cls = `ai-tool${item.isError ? ' error' : ''}${item.done ? '' : ' pending'}`;
  if (!item.detail && !item.isError) {
    return (
      <div className={cls}>
        <span className="ai-tool-icon">{icon}</span>
        <span>{label}</span>
      </div>
    );
  }
  return (
    <details className={cls}>
      <summary>
        <span className="ai-tool-icon">{icon}</span>
        <span>{label}</span>
      </summary>
      {item.detail && <pre className={item.name === 'edit' || item.name === 'write' ? 'ai-diff' : undefined}>{item.detail}</pre>}
    </details>
  );
}

function ChangeCard({
  turn,
  onUndo,
  onOpenNote,
  disabled,
}: {
  turn: AiTurn;
  onUndo(changeIds?: string[], resolution?: UndoResolution): Promise<UndoResult[]>;
  onOpenNote(target: string): void;
  disabled: boolean;
}) {
  const [outcomes, setOutcomes] = useState<Record<string, UndoResult>>({});
  const [busy, setBusy] = useState(false);
  const pending = turn.changes.filter((c) => !c.undone && !['undone', 'copied', 'skipped'].includes(outcomes[c.id]?.status ?? ''));

  async function undo(ids?: string[], resolution?: UndoResolution) {
    setBusy(true);
    try {
      const results = await onUndo(ids, resolution);
      setOutcomes((o) => ({ ...o, ...Object.fromEntries(results.map((r) => [r.id, r])) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ai-changes">
      <div className="ai-changes-head">
        <strong>
          Changed {turn.changes.length} file{turn.changes.length === 1 ? '' : 's'}
        </strong>
        {pending.length > 0 && (
          <button disabled={disabled || busy} onClick={() => void undo()}>
            Undo all
          </button>
        )}
      </div>
      {turn.changes.map((c) => {
        const outcome = outcomes[c.id];
        // the server's snapshot marks c.undone too; the outcome covers the gap until it arrives
        const done = c.undone || outcome?.status === 'undone' || outcome?.status === 'copied' || outcome?.status === 'skipped';
        const name = c.op === 'move' ? `${c.from} → ${c.path}` : c.path;
        return (
          <div key={c.id} className={`ai-change${done ? ' undone' : ''}`}>
            <div className="ai-change-row">
              <span className="ai-tool-icon">{OP_ICONS[c.op]}</span>
              {c.op === 'delete' || done ? (
                <span className="ai-change-path">{name}</span>
              ) : (
                <button className="ai-change-path link" onClick={() => onOpenNote(c.path)}>
                  {name}
                </button>
              )}
              {(c.added > 0 || c.removed > 0) && (
                <span className="ai-change-stat">
                  <span className="add">+{c.added}</span> <span className="del">−{c.removed}</span>
                </span>
              )}
              {done ? (
                <span className="ai-change-state">{outcome?.status === 'copied' ? `Restored as ${outcome.copyPath}` : outcome?.status === 'skipped' ? 'Skipped' : 'Undone'}</span>
              ) : (
                <button aria-label={`Undo ${c.path}`} disabled={disabled || busy} onClick={() => void undo([c.id])}>
                  Undo
                </button>
              )}
            </div>
            {!done && outcome?.status === 'conflict' && (
              <div className="ai-conflict" role="alert">
                <span>{outcome.message ?? 'The file changed after the agent edited it.'}</span>
                <span className="ai-conflict-actions">
                  <button disabled={busy} onClick={() => void undo([c.id], 'copy')}>Restore as copy</button>
                  <button disabled={busy} onClick={() => void undo([c.id], 'overwrite')}>Overwrite</button>
                  <button disabled={busy} onClick={() => void undo([c.id], 'skip')}>Skip</button>
                </span>
              </div>
            )}
            {!done && outcome?.status === 'failed' && (
              <div className="ai-error" role="alert">Undo failed: {outcome.message}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TurnView({
  turn,
  model,
  onOpenNote,
  onUndo,
  undoDisabled,
}: {
  turn: AiTurn;
  model: string;
  onOpenNote(target: string): void;
  onUndo(changeIds?: string[], resolution?: UndoResolution): Promise<UndoResult[]>;
  undoDisabled: boolean;
}) {
  const usage = turn.usage;
  const cost = usage ? estimateCost(model, usage) : undefined;
  const last = turn.items.at(-1);
  const working = turn.status === 'running' && (!last || last.kind !== 'text');
  return (
    <div className="ai-entry">
      <div className="ai-request">
        <div className="ai-request-text">{turn.prompt}</div>
        {(turn.context.path || turn.context.selection) && (
          <div className="ai-context">
            {turn.context.path && <span className="ai-tag">📄 {turn.context.path.replace(/\.md$/, '')}</span>}
            {turn.context.selection && <span className="ai-tag">selection</span>}
          </div>
        )}
      </div>
      {turn.items.map((item) => (
        <ItemView key={item.id} item={item} onOpenNote={onOpenNote} />
      ))}
      {working && <div className="ai-working">Working…</div>}
      {turn.status === 'error' && (
        <div className="ai-error" role="alert">
          {turn.error ?? 'The agent stopped with an error.'}
        </div>
      )}
      {turn.status === 'stopped' && <div className="ai-stopped">{turn.error ?? 'Stopped.'}</div>}
      {turn.changes.length > 0 && (
        <ChangeCard turn={turn} onUndo={onUndo} onOpenNote={onOpenNote} disabled={undoDisabled} />
      )}
      {usage && turn.status !== 'running' && (
        <div className="ai-usage">
          {fmtTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} in · {fmtTokens(usage.outputTokens)} out
          {cost !== undefined && ` · ~$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`}
        </div>
      )}
    </div>
  );
}
