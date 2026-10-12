import { beforeEach, describe, expect, it } from 'vitest';
import { extractEmails, isValidEmail, parseRecipients, recentRecipients, rememberRecipients } from '../src/emails';

describe('extractEmails', () => {
  it('finds plain and mailto addresses in note order, without duplicates', () => {
    const md = [
      '> [!note] Kontakt',
      '> **E-post:** Andreas.fagerstrom@fcg.fi',
      'Mail [Anna](mailto:anna.b@example.com) or andreas.FAGERSTROM@fcg.fi.',
      'Trailing dot: info@firma.se.',
    ].join('\n');
    expect(extractEmails(md)).toEqual(['Andreas.fagerstrom@fcg.fi', 'anna.b@example.com', 'info@firma.se']);
  });

  it('returns nothing for a note without addresses', () => {
    expect(extractEmails('# Plan\n\nno contacts @here')).toEqual([]);
  });
});

describe('isValidEmail', () => {
  it.each(['a@b.fi', 'first.last+tag@sub.example.com'])('accepts %s', (s) => expect(isValidEmail(s)).toBe(true));
  it.each(['andreas@fcg', 'andreas', '@x.fi', 'a b@c.fi', 'a@b.c'])('rejects %s', (s) => expect(isValidEmail(s)).toBe(false));
});

describe('parseRecipients', () => {
  it('splits on commas, semicolons and whitespace', () => {
    expect(parseRecipients('a@x.fi, b@y.fi;c@z.fi  d@w.fi')).toEqual(['a@x.fi', 'b@y.fi', 'c@z.fi', 'd@w.fi']);
  });

  it('takes addresses out of "Name <address>" lists and mailto: prefixes', () => {
    expect(parseRecipients('Andreas Fagerström <andreas@fcg.fi>, "Anna B" <anna@x.fi>; mailto:c@d.fi')).toEqual([
      'andreas@fcg.fi',
      'anna@x.fi',
      'c@d.fi',
    ]);
  });

  it('keeps a lone word so the user sees it is not an address', () => {
    expect(parseRecipients('andreas')).toEqual(['andreas']);
  });
});

describe('recent recipients', () => {
  beforeEach(() => localStorage.clear());

  it('remembers sent-to addresses, most recent first, without duplicates', () => {
    rememberRecipients(['a@x.fi', 'b@x.fi']);
    rememberRecipients(['C@x.fi', 'A@X.FI']);
    expect(recentRecipients()).toEqual(['C@x.fi', 'A@X.FI', 'b@x.fi']);
  });

  it('survives unreadable storage', () => {
    localStorage.setItem('noteviewer.share.recent', '{not json');
    expect(recentRecipients()).toEqual([]);
  });
});
