import { useEffect, useRef, useState } from 'react';
import type { AiAction, AiStatus } from '@noteviewer/shared';
import { ApiError, streamAi, type AiRequest } from '../api';
import { renderMarkdown } from '../md/render';

export type ApplyMode = 'insert' | 'append' | 'replace';

export interface AiPanelProps {
  status: AiStatus | null;
  /** open note path, or null when none is open */
  path: string | null;
  /** live note buffer */
  getContent(): string;
  /** current editor selection ('' when none or not in edit mode) */
  getSelection(): string;
  onApply(mode: ApplyMode, text: string): void;
  onOpenProfile(): void;
  onClose(): void;
}

interface Entry {
  id: number;
  action: AiAction;
  /** what the user sees as their request */
  label: string;
  /** free-form question, for chat history */
  prompt?: string;
  usedSelection: boolean;
  output: string;
  streaming: boolean;
  error?: string;
}

const QUICK_ACTIONS: { action: AiAction; label: string; title: string }[] = [
  { action: 'summarize', label: 'Summarize', title: 'TL;DR and key points' },
  { action: 'tidy', label: 'Tidy up', title: 'Restructure and fix language, keeping all content' },
  { action: 'tasks', label: 'Action items', title: 'Extract to-dos as a task list' },
  { action: 'links', label: 'Tags & links', title: 'Suggest tags and [[links]] to existing notes' },
  { action: 'continue', label: 'Continue', title: 'Keep writing in the same style' },
];

let entrySeq = 0;

export function AiPanel({ status, path, getContent, getSelection, onApply, onOpenProfile, onClose }: AiPanelProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [scope, setScope] = useState<'note' | 'vault'>('note');
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = entries.some((e) => e.streaming);
  // without an open note, questions can only go to the vault
  const effectiveScope = path ? scope : 'vault';

  // A conversation belongs to one note; switching notes starts fresh.
  useEffect(() => {
    abortRef.current?.abort();
    setEntries([]);
  }, [path]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  function patch(id: number, fn: (e: Entry) => Partial<Entry>) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...fn(e) } : e)));
  }

  async function run(action: AiAction, label: string, prompt?: string) {
    if (busy) return;
    const selection = path ? getSelection() : '';
    const id = ++entrySeq;
    const req: AiRequest = { action, prompt };
    if (path) {
      req.path = path;
      req.content = getContent();
      if (selection) req.selection = selection;
    }
    if (action === 'ask' || action === 'ask-vault') {
      req.history = entries
        .filter((e) => (e.action === 'ask' || e.action === 'ask-vault') && !e.error && e.output)
        .flatMap((e) => [
          { role: 'user' as const, text: e.prompt ?? e.label },
          { role: 'model' as const, text: e.output },
        ]);
    }
    setEntries((es) => [...es, { id, action, label, prompt, usedSelection: Boolean(selection), output: '', streaming: true }]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamAi(req, (delta) => patch(id, (e) => ({ output: e.output + delta })), ctrl.signal);
      patch(id, () => ({ streaming: false }));
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      patch(id, () => ({
        streaming: false,
        error: aborted ? undefined : err instanceof ApiError ? err.message : 'AI request failed',
      }));
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }

  function ask() {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    void run(effectiveScope === 'vault' ? 'ask-vault' : 'ask', q, q);
  }

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <div className="ai-header">
        <strong>AI</strong>
        {status?.enabled && <span className="ai-model">{status.model}</span>}
        <span className="ai-header-tools">
          {status?.enabled && (
            <button onClick={onOpenProfile} title={`Personalise the assistant by editing ${status.profileNote}`}>
              {status.profileExists ? 'Profile' : 'Set up profile'}
            </button>
          )}
          {entries.length > 0 && (
            <button onClick={() => { abortRef.current?.abort(); setEntries([]); }} title="Clear conversation">Clear</button>
          )}
          <button aria-label="Close AI panel" onClick={onClose}>✕</button>
        </span>
      </div>

      {!status ? (
        <div className="panel-empty">Checking AI status…</div>
      ) : !status.enabled ? (
        <div className="ai-disabled">
          AI is not configured. Set <code>GEMINI_API_KEY</code> on the server (get one at
          {' '}<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>)
          {' '}and restart.
        </div>
      ) : (
        <>
          {path && (
            <div className="ai-quick">
              {QUICK_ACTIONS.map((q) => (
                <button key={q.action} title={q.title} disabled={busy} onClick={() => void run(q.action, q.label)}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <div className="ai-log" ref={logRef} data-testid="ai-log">
            {entries.length === 0 && (
              <div className="panel-empty">
                {path
                  ? 'Run an action on this note (or your selection), or ask a question below.'
                  : 'Ask a question about your vault.'}
              </div>
            )}
            {entries.map((e) => (
              <div key={e.id} className="ai-entry">
                <div className="ai-request">
                  {e.label}
                  {e.usedSelection && <span className="ai-tag">selection</span>}
                  {e.action === 'ask-vault' && <span className="ai-tag">vault</span>}
                </div>
                {e.error ? (
                  <div className="ai-error" role="alert">{e.error}</div>
                ) : (
                  <AiOutput text={e.output} streaming={e.streaming} />
                )}
                {!e.streaming && !e.error && e.output && (
                  <div className="ai-apply">
                    {path && (
                      <>
                        <button onClick={() => onApply('insert', e.output)} title="Insert at the cursor (replaces the selection)">Insert</button>
                        <button onClick={() => onApply('append', e.output)} title="Append to the end of the note">Append</button>
                        {e.action === 'tidy' && (
                          <button onClick={() => onApply('replace', e.output)} title={e.usedSelection ? 'Replace the selection' : 'Replace the whole note'}>
                            {e.usedSelection ? 'Replace selection' : 'Replace note'}
                          </button>
                        )}
                      </>
                    )}
                    <button onClick={() => void navigator.clipboard?.writeText(e.output)}>Copy</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          <form
            className="ai-ask"
            onSubmit={(ev) => { ev.preventDefault(); ask(); }}
          >
            <textarea
              value={question}
              rows={3}
              placeholder={effectiveScope === 'vault' ? 'Ask across your notes…' : 'Ask about this note…'}
              aria-label="Question"
              onChange={(ev) => setQuestion(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ask(); }
              }}
            />
            <div className="ai-ask-row">
              <div className="ai-scope" role="group" aria-label="Question scope">
                <button type="button" aria-pressed={effectiveScope === 'note'} disabled={!path} onClick={() => setScope('note')}>This note</button>
                <button type="button" aria-pressed={effectiveScope === 'vault'} onClick={() => setScope('vault')}>Vault</button>
              </div>
              {busy ? (
                <button type="button" onClick={() => abortRef.current?.abort()}>Stop</button>
              ) : (
                <button type="submit" className="primary" disabled={!question.trim()}>Ask</button>
              )}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}

function AiOutput({ text, streaming }: { text: string; streaming: boolean }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    void renderMarkdown(text).then((h) => { if (!cancelled) setHtml(h); });
    return () => { cancelled = true; };
  }, [text]);
  if (!text && streaming) return <div className="ai-output ai-thinking">Thinking…</div>;
  return <div className="ai-output reading-view" dangerouslySetInnerHTML={{ __html: html }} />;
}
