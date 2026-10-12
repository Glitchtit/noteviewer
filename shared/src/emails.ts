/** Email address extraction, shared by the vault index and the share dialog. */

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Drop case-insensitive duplicates, keeping the first spelling. */
export function dedupeEmails(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = e.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Addresses mentioned in a note (plain text or mailto: links), in order, first spelling kept. */
export function extractEmails(markdown: string): string[] {
  return dedupeEmails(markdown.match(EMAIL_IN_TEXT) ?? []);
}

/** One address found in the vault and the notes that mention it. */
export interface AddressBookEntry {
  email: string;
  notes: { path: string; title: string }[];
}
