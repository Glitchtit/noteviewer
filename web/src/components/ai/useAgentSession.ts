import { useCallback, useEffect, useRef, useState } from 'react';
import { foldEvent, type AgentEvent, type AiEffort, type AiSession, type AiSessionSummary, type UndoResolution, type UndoResult } from '@noteviewer/shared';
import { aiEventsUrl, api, apiErrorMessage } from '../../api';

const LAST_SESSION_KEY = 'noteviewer.ai.session';

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

function remember(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    // storage unavailable: the panel just won't reopen the session
  }
}

export interface AgentSessionApi {
  sessions: AiSessionSummary[];
  session: AiSession | null;
  sessionId: string | null;
  error: string | null;
  select(id: string | null): void;
  send(input: { prompt: string; path?: string; selection?: string; model?: string; effort?: AiEffort }): Promise<void>;
  stop(): void;
  undo(turnId: string, changeIds?: string[], resolution?: UndoResolution): Promise<UndoResult[]>;
  remove(id: string): Promise<void>;
  clearError(): void;
}

/**
 * The selected agent session, kept live over SSE: the server sends a
 * snapshot on (re)connect, then run events that are folded in exactly as the
 * server folds them.
 */
export function useAgentSession(enabled: boolean): AgentSessionApi {
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<AiSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  idRef.current = sessionId;

  const refreshList = useCallback(async () => {
    try {
      setSessions(await api.aiSessions());
    } catch {
      // list is a convenience; keep the old one
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api
      .aiSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        const last = remembered();
        if (last && !idRef.current && list.some((s) => s.id === last)) setSessionId(last);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const es = new EventSource(aiEventsUrl(sessionId));
    es.onmessage = (msg) => {
      let e: AgentEvent;
      try {
        e = JSON.parse(msg.data as string) as AgentEvent;
      } catch {
        return;
      }
      if (e.type === 'snapshot') {
        setSession(e.session);
        return;
      }
      setSession((s) =>
        s && s.id === sessionId
          ? {
              ...s,
              turns: foldEvent(s.turns, e),
              running: e.type === 'turn_start' ? true : e.type === 'turn_end' ? false : s.running,
            }
          : s,
      );
      if (e.type === 'turn_end' || e.type === 'turn_start') void refreshList();
    };
    return () => es.close();
  }, [enabled, sessionId, refreshList]);

  const select = useCallback((id: string | null) => {
    setSessionId(id);
    setSession(null);
    setError(null);
    remember(id);
  }, []);

  const send = useCallback(
    async (input: { prompt: string; path?: string; selection?: string; model?: string; effort?: AiEffort }) => {
      setError(null);
      try {
        let id = idRef.current;
        if (!id) {
          id = (await api.aiCreateSession()).id;
          idRef.current = id;
          setSessionId(id);
          remember(id);
        }
        await api.aiRun(id, input);
        // a new session (and its title) only exists server-side from here on
        void refreshList();
      } catch (err) {
        setError(apiErrorMessage(err, 'Could not start the agent.'));
      }
    },
    [refreshList],
  );

  const stop = useCallback(() => {
    const id = idRef.current;
    if (id) void api.aiStop(id).catch(() => {});
  }, []);

  const undo = useCallback(async (turnId: string, changeIds?: string[], resolution?: UndoResolution) => {
    const id = idRef.current;
    if (!id) return [];
    const body: { changeIds?: string[]; resolution?: UndoResolution } = {};
    if (changeIds) body.changeIds = changeIds;
    if (resolution) body.resolution = resolution;
    try {
      return (await api.aiUndo(id, turnId, body)).results;
    } catch (err) {
      setError(apiErrorMessage(err, 'Undo failed.'));
      return [];
    }
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.aiDeleteSession(id);
        if (idRef.current === id) select(null);
        await refreshList();
      } catch (err) {
        setError(apiErrorMessage(err, 'Could not delete the session.'));
      }
    },
    [refreshList, select],
  );

  return { sessions, session, sessionId, error, select, send, stop, undo, remove, clearError: () => setError(null) };
}
