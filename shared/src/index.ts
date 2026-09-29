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

export interface GraphNode {
  /** vault-relative path for resolved notes; the raw link target for unresolved ones */
  id: string;
  title: string;
  tags: string[];
  /** true when the node is a wikilink target with no matching note on disk */
  unresolved: boolean;
  /** number of resolved notes linking to this node */
  inbound: number;
  /** number of distinct outgoing link targets */
  outbound: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AiStatus {
  /** false when the server has no GEMINI_API_KEY */
  enabled: boolean;
  model: string;
  /** vault-relative path of the note whose contents personalise the assistant */
  profileNote: string;
  profileExists: boolean;
}

export type AiAction = 'ask' | 'ask-vault' | 'summarize' | 'tidy' | 'tasks' | 'links' | 'continue';

/** Starting content for the profile note that personalises the AI assistant. */
export const PROFILE_TEMPLATE = `# AI Profile

This note is read by the AI assistant on every request. Describe yourself and
how you like your notes kept — edit freely.

## About me
- Role / what I use these notes for:
- Languages I write in:

## How I like my notes
- Preferred structure (headings, bullet lists, callouts…):
- Tag conventions (e.g. #kurs/el, #todo):
- Folder conventions:

## How the assistant should answer
- Tone and length:
- Things to avoid:
`;
