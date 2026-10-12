import { useEffect, useRef, useState } from 'react';
import { QUICK_PROMPTS, type AiStatus } from '@noteviewer/shared';
import { TurnView } from './ai/TurnView';
import { useAgentSession } from './ai/useAgentSession';

export interface AiPanelProps {
  status: AiStatus | null;
  /** open note path, or null when none is open */
  path: string | null;
  /** current editor selection ('' when none or not in edit mode) */
  getSelection(): string;
  /** flush unsaved edits so the agent reads what the user sees */
  saveNow(): Promise<void>;
  /** open a note by [[link]] target or vault path */
  onOpenNote(target: string): void;
  onOpenProfile(): void;
  onClose(): void;
}

export function AiPanel({ status, path, getSelection, saveNow, onOpenNote, onOpenProfile, onClose }: AiPanelProps) {
  const enabled = Boolean(status?.enabled);
  const agent = useAgentSession(enabled);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = sending || Boolean(agent.session?.running);
  const turns = agent.session?.turns ?? [];

  // follow the conversation while it streams, unless the user scrolled up
  const stickRef = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [agent.session]);

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setSending(true);
    try {
      const selection = path ? getSelection() : '';
      await saveNow();
      const input: { prompt: string; path?: string; selection?: string } = { prompt: text };
      if (path) input.path = path;
      if (selection) input.selection = selection;
      setMessage('');
      stickRef.current = true;
      await agent.send(input);
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <div className="ai-header">
        <strong>AI</strong>
        {enabled && (
          <select
            className="ai-session-select"
            aria-label="Session"
            value={agent.sessionId ?? ''}
            onChange={(e) => agent.select(e.target.value || null)}
          >
            <option value="">New session</option>
            {agent.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.running ? '● ' : ''}
                {s.title}
              </option>
            ))}
          </select>
        )}
        <span className="ai-header-tools">
          {enabled && (
            <>
              <button aria-label="New session" title="New session" onClick={() => agent.select(null)}>＋</button>
              {agent.sessionId && (
                <button
                  aria-label="Delete session"
                  title="Delete this session"
                  disabled={busy}
                  onClick={() => void agent.remove(agent.sessionId!)}
                >
                  🗑
                </button>
              )}
              <button onClick={onOpenProfile} title={`Personalise the agent by editing ${status!.profileNote}`}>
                {status!.profileExists ? 'Profile' : 'Set up profile'}
              </button>
            </>
          )}
          <button aria-label="Close AI panel" onClick={onClose}>✕</button>
        </span>
      </div>

      {!status ? (
        <div className="panel-empty">Checking AI status…</div>
      ) : !enabled ? (
        <div className="ai-disabled">
          The agent is not configured. Set <code>ANTHROPIC_API_KEY</code> on the server (create one in the{' '}
          <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Claude Console</a>) and restart.
        </div>
      ) : (
        <>
          <div
            className="ai-log"
            ref={logRef}
            data-testid="ai-log"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {turns.length === 0 && (
              <div className="panel-empty">
                Ask Claude to find, write, reorganise or clean up notes anywhere in the vault. Every change it makes can be undone.
                <span className="ai-model">{status.model}</span>
              </div>
            )}
            {turns.map((t) => (
              <TurnView
                key={t.id}
                turn={t}
                model={agent.session!.model}
                onOpenNote={onOpenNote}
                undoDisabled={busy}
                onUndo={(ids, resolution) => agent.undo(t.id, ids, resolution)}
              />
            ))}
          </div>
          {agent.error && (
            <div className="ai-error ai-panel-error" role="alert">
              {agent.error}
            </div>
          )}
          <div className="ai-quick">
            {QUICK_PROMPTS.map((q) => (
              <button key={q.id} title={q.title} disabled={!path || busy} onClick={() => void send(q.prompt)}>
                {q.label}
              </button>
            ))}
          </div>
          <form
            className="ai-ask"
            onSubmit={(ev) => {
              ev.preventDefault();
              void send(message);
            }}
          >
            <textarea
              value={message}
              rows={3}
              placeholder={path ? 'Ask or tell Claude what to do — the open note is shared as context' : 'Ask or tell Claude what to do in your vault'}
              aria-label="Message"
              onChange={(ev) => setMessage(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && !ev.shiftKey) {
                  ev.preventDefault();
                  void send(message);
                }
              }}
            />
            <div className="ai-ask-row">
              <span className="ai-hint">{path ? `📄 ${path.replace(/\.md$/, '')}` : 'No note open'}</span>
              {agent.session?.running ? (
                <button type="button" onClick={agent.stop}>Stop</button>
              ) : (
                <button type="submit" className="primary" disabled={!message.trim() || busy}>Send</button>
              )}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}
