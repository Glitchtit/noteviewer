import { useId, useRef, useState } from 'react';
import { isValidEmail, parseRecipients } from '../emails';

export interface Suggestion {
  email: string;
  /** where it came from: the shared note, another vault note, or addresses emailed before */
  source: 'note' | 'vault' | 'recent';
  /** shown beside the address (for vault addresses: the note it's in) */
  label?: string;
  /** extra text the typed filter also matches, e.g. note titles and paths */
  search?: string;
}

export interface RecipientInputProps {
  label: string;
  /** committed recipients, shown as pills */
  pills: string[];
  /** text still being typed */
  draft: string;
  suggestions: Suggestion[];
  onChange(pills: string[], draft: string): void;
}

/** a cap for very large address books; the list itself scrolls */
const MAX_SUGGESTIONS = 100;
const SEPARATOR = /[,;\s]/;

/** Gmail-style recipient field: typed addresses become removable pills, with suggestions. */
export function RecipientInput({ label, pills, draft, suggestions, onChange }: RecipientInputProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const taken = new Set(pills.map((p) => p.toLowerCase()));
  const needle = draft.trim().toLowerCase();
  const matches = suggestions
    .filter(
      (s) =>
        !taken.has(s.email.toLowerCase()) &&
        (!needle || `${s.email} ${s.label ?? ''} ${s.search ?? ''}`.toLowerCase().includes(needle)),
    )
    .slice(0, MAX_SUGGESTIONS);
  const showList = open && matches.length > 0;

  function add(emails: string[], rest = '') {
    const next = [...pills];
    for (const e of emails) {
      if (!next.some((p) => p.toLowerCase() === e.toLowerCase())) next.push(e);
    }
    onChange(next, rest);
    setActive(-1);
  }

  function commitDraft() {
    if (draft.trim()) add(parseRecipients(draft));
  }

  function onType(value: string) {
    // a separator ends an address: everything before the last one becomes pills
    if (SEPARATOR.test(value)) {
      const lastSep = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'), value.search(/\s(?=\S*$)/));
      add(parseRecipients(value.slice(0, lastSep + 1)), value.slice(lastSep + 1).trimStart());
    } else {
      onChange(pills, value);
      setActive(-1);
    }
    setOpen(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!matches.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + matches.length) % matches.length);
    } else if (e.key === 'Enter') {
      // never submit the form from here: Enter confirms an address
      e.preventDefault();
      if (showList && active >= 0) add([matches[active]!.email]);
      else commitDraft();
    } else if (e.key === 'Tab' && draft.trim()) {
      commitDraft();
    } else if (e.key === 'Backspace' && draft === '' && pills.length) {
      onChange(pills.slice(0, -1), '');
    } else if (e.key === 'Escape' && showList) {
      // close the list only; the dialog stays open
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  }

  return (
    <div className="recipients" onClick={() => inputRef.current?.focus()}>
      {pills.map((p) => (
        <span key={p} className={`recipient-pill${isValidEmail(p) ? '' : ' invalid'}`} data-testid="recipient-pill" title={isValidEmail(p) ? p : `${p} is not a valid address`}>
          <span>{p}</span>
          <button
            type="button"
            aria-label={`Remove ${p}`}
            onClick={(e) => {
              e.stopPropagation();
              onChange(pills.filter((x) => x !== p), draft);
            }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        aria-label={label}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={pills.length ? '' : 'To: type or pick an address'}
        value={draft}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          commitDraft();
        }}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (!SEPARATOR.test(text.trim()) && !text.includes('<')) return;
          e.preventDefault();
          add(parseRecipients(`${draft}${text}`));
        }}
      />
      {showList && (
        <ul className="recipient-suggestions" role="listbox" id={listId}>
          {matches.map((s, i) => (
            <li
              key={s.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              // mousedown, not click: picking must happen before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                add([s.email]);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{s.email}</span>
              <span className="recipient-source">
                {s.source === 'note' ? 'in note' : s.source === 'recent' ? 'recent' : s.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
