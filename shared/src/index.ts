export interface TreeNode {
  name: string;
  /** vault-relative, '/'-separated, no leading '/' */
  path: string;
  type: 'folder' | 'note' | 'file';
  children?: TreeNode[];
}

export interface Heading {
  level: number;
  text: string;
}

export interface NoteMeta {
  path: string;
  title: string;
  tags: string[];
  /** raw wikilink targets as written, e.g. "Sub Note" or "folder/Sub Note" */
  links: string[];
  headings: Heading[];
  mtimeMs: number;
  /** sha256 hex of the file content — the conflict-guard token */
  hash: string;
}

export interface NoteResponse {
  meta: NoteMeta;
  backlinks: string[];
  content: string;
}

export interface SearchResult {
  path: string;
  title: string;
  score: number;
}

export type VaultEvent =
  | { type: 'note-changed'; path: string }
  | { type: 'tree-changed' };
