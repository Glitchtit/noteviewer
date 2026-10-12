/** Email address helpers for the share dialog's recipient field. */

import { dedupeEmails, extractEmails } from '@noteviewer/shared';

export { extractEmails };

const VALID = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>".]{2,}$/;
const RECENT_KEY = 'noteviewer.share.recent';
const RECENT_MAX = 30;

export function isValidEmail(s: string): boolean {
  return VALID.test(s);
}

/**
 * Split typed or pasted text into recipients. Separators are commas,
 * semicolons and whitespace; "Name <address>" lists keep just the address.
 */
export function parseRecipients(text: string): string[] {
  const tokens = text
    .split(/[,;\s]+/)
    .map((t) => t.replace(/^["'<(]+|["'>),.]+$/g, '').replace(/^mailto:/i, ''))
    .filter(Boolean);
  // in a list that contains addresses, words without "@" are display names
  const hasAddress = tokens.some((t) => t.includes('@'));
  return hasAddress && tokens.length > 1 ? tokens.filter((t) => t.includes('@')) : tokens;
}

export function recentRecipients(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Put just-used addresses at the front of the recent list. */
export function rememberRecipients(emails: string[]): void {
  try {
    const next = dedupeEmails([...emails, ...recentRecipients()]).slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: no suggestions from history
  }
}
