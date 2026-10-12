import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RecipientInput, type Suggestion } from '../src/components/RecipientInput';

const SUGGESTIONS: Suggestion[] = [
  { email: 'Andreas.fagerstrom@fcg.fi', source: 'note' },
  { email: 'anna@example.com', source: 'note' },
  { email: 'kalle@kund.fi', source: 'vault', label: 'Kalle Karlsson +1', search: 'Kalle Karlsson Kunder/Acme' },
  { email: 'boss@firma.se', source: 'recent' },
];

function Harness({ initial = [] as string[], onState = (_p: string[], _d: string) => {} }) {
  const [pills, setPills] = useState<string[]>(initial);
  const [draft, setDraft] = useState('');
  return (
    <RecipientInput
      label="To"
      pills={pills}
      draft={draft}
      suggestions={SUGGESTIONS}
      onChange={(p, d) => {
        setPills(p);
        setDraft(d);
        onState(p, d);
      }}
    />
  );
}

const input = () => screen.getByLabelText('To') as HTMLInputElement;
const pillTexts = () => screen.queryAllByTestId('recipient-pill').map((p) => p.firstChild!.textContent);

function type(text: string) {
  fireEvent.change(input(), { target: { value: input().value + text } });
}

describe('RecipientInput pills', () => {
  it('turns an address into a pill on Enter', () => {
    render(<Harness />);
    type('x@example.com');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(pillTexts()).toEqual(['x@example.com']);
    expect(input().value).toBe('');
  });

  it.each([',', ';', ' '])('turns an address into a pill when "%s" is typed', (sep) => {
    render(<Harness />);
    type(`x@example.com${sep}`);
    expect(pillTexts()).toEqual(['x@example.com']);
    expect(input().value).toBe('');
  });

  it('turns pasted lists into several pills', () => {
    render(<Harness />);
    fireEvent.paste(input(), { clipboardData: { getData: () => 'Anna <anna@x.fi>, b@y.fi' } });
    expect(pillTexts()).toEqual(['anna@x.fi', 'b@y.fi']);
  });

  it('commits what was typed when the field loses focus', () => {
    render(<Harness />);
    type('x@example.com');
    fireEvent.blur(input());
    expect(pillTexts()).toEqual(['x@example.com']);
  });

  it('ignores duplicates regardless of case', () => {
    render(<Harness initial={['x@example.com']} />);
    type('X@Example.com,');
    expect(pillTexts()).toEqual(['x@example.com']);
  });

  it('marks invalid addresses', () => {
    render(<Harness />);
    type('andreas@fcg,');
    expect(screen.getByTestId('recipient-pill').className).toContain('invalid');
  });

  it('removes pills with Backspace on an empty field and with their ✕', () => {
    render(<Harness initial={['a@x.fi', 'b@x.fi', 'c@x.fi']} />);
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(pillTexts()).toEqual(['a@x.fi', 'b@x.fi']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove a@x.fi' }));
    expect(pillTexts()).toEqual(['b@x.fi']);
  });
});

describe('RecipientInput suggestions', () => {
  it('lists suggestions on focus, note addresses first, with their source', () => {
    render(<Harness />);
    fireEvent.focus(input());
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Andreas.fagerstrom@fcg.fiin note',
      'anna@example.comin note',
      'kalle@kund.fiKalle Karlsson +1',
      'boss@firma.serecent',
    ]);
  });

  it("matches what's typed against the note a vault address comes from", () => {
    render(<Harness />);
    fireEvent.focus(input());
    type('karlsson');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['kalle@kund.fiKalle Karlsson +1']);
    fireEvent.change(input(), { target: { value: 'acme' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('offers long address books in full (the list scrolls)', () => {
    const many: Suggestion[] = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@x.fi`, source: 'vault', label: `P${i}` }));
    render(<RecipientInput label="To" pills={[]} draft="" suggestions={many} onChange={() => {}} />);
    fireEvent.focus(input());
    expect(screen.getAllByRole('option')).toHaveLength(20);
  });

  it('filters while typing and hides addresses already added', () => {
    render(<Harness initial={['anna@example.com']} />);
    fireEvent.focus(input());
    type('fcg');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Andreas.fagerstrom@fcg.fiin note']);
  });

  it('picks a suggestion by mouse', () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.mouseDown(screen.getByRole('option', { name: /boss@firma\.se/ }));
    expect(pillTexts()).toEqual(['boss@firma.se']);
  });

  it('picks a suggestion with the arrow keys and Enter', () => {
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(pillTexts()).toEqual(['anna@example.com']);
  });

  it('closes the list on Escape without letting the key reach the dialog', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(<Harness />);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onWindowKey).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowKey);
  });

  it('shows no list when there is nothing to suggest', () => {
    render(<RecipientInput label="To" pills={[]} draft="" suggestions={[]} onChange={() => {}} />);
    fireEvent.focus(input());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
