/**
 * The note-keeping "skill": a fixed system prompt describing how the assistant
 * should behave inside this vault, plus per-action task prompts. The user can
 * extend it with a profile note in the vault (see AI_PROFILE_NOTE).
 */

import type { AiAction } from '@noteviewer/shared';

export type { AiAction };
export const AI_ACTIONS: readonly AiAction[] = ['ask', 'ask-vault', 'summarize', 'tidy', 'tasks', 'links', 'continue'];

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface SkillContext {
  action: AiAction;
  /** vault-relative path of the open note, if any */
  path?: string;
  /** current editor buffer (may be unsaved) */
  content?: string;
  /** text the user has selected in the editor */
  selection?: string;
  /** free-form instruction or question */
  prompt?: string;
  /** earlier turns of an 'ask' / 'ask-vault' conversation */
  history?: ChatTurn[];
  /** contents of the user's profile note, if it exists */
  profile?: string;
  /** vault note names (no .md) available as [[link]] targets */
  noteNames?: string[];
  /** tags already used across the vault, most frequent first */
  tags?: string[];
  /** notes retrieved from the search index for 'ask-vault' */
  related?: { path: string; content: string }[];
}

const SYSTEM = `You are the note-keeping assistant built into noteviewer, a self-hosted, Obsidian-compatible Markdown vault.
Your job is to help the user capture, organise, and retrieve their own notes. You are a careful editor, not an author with an agenda.

Vault conventions you must follow in anything you write:
- Output GitHub-flavoured Markdown only. Never wrap the whole answer in a code fence.
- Link to other notes with Obsidian wikilinks: [[Note Name]] or [[Note Name|label]]. Only link to notes that exist in the provided note list unless explicitly asked to propose new notes.
- Tags are inline #tags (letters, digits, -, _, / for nesting). Reuse tags already present in the vault's notes rather than inventing near-duplicates.
- Tasks are "- [ ] task" / "- [x] done". Keep any existing task state.
- Callouts use "> [!note] Title", "> [!tip]", "> [!warning]" etc.
- Math uses $inline$ and $$block$$ (KaTeX). Diagrams use \`\`\`mermaid fences.
- YAML frontmatter (between leading --- lines) is metadata: preserve it byte-for-byte when rewriting a note.
- A note is a Kanban board when its frontmatter contains "kanban-plugin"; keep its "## Column" / "- [ ] card" structure intact.

Behaviour:
- Write in the same language as the note (or the user's question). Do not translate unless asked.
- Preserve the user's facts, wording and voice. Never invent facts, dates, names, or sources; if something is unclear, say so briefly.
- Be concise. No preamble like "Sure!" or "Here is…", no closing offers of further help.
- When answering from notes, cite the notes you used as [[wikilinks]].`;

function fence(label: string, body: string): string {
  return `<${label}>\n${body}\n</${label}>`;
}

const MAX_NOTE_NAMES = 2000;

function taskFor(ctx: SkillContext): string {
  const target = ctx.selection?.trim() ? 'the selected text' : 'the current note';
  const extra = ctx.prompt?.trim() ? `\n\nAdditional instructions from the user: ${ctx.prompt.trim()}` : '';
  switch (ctx.action) {
    case 'ask':
      return (ctx.prompt ?? '').trim() || 'What is this note about?';
    case 'ask-vault':
      return `Answer using the related notes provided (and the current note if relevant). If they do not contain the answer, say so plainly instead of guessing.\n\nQuestion: ${(ctx.prompt ?? '').trim()}`;
    case 'summarize':
      return `Summarise ${target}. Start with a one-sentence TL;DR in bold, then 3–7 bullet points with the key points, then an "Open questions" bullet list only if the note leaves things unresolved.${extra}`;
    case 'tidy':
      return `Rewrite ${target} into clean, well-structured Markdown: fix spelling and grammar, add sensible headings, turn run-on text into lists where it helps, convert obvious to-dos into "- [ ]" tasks. Keep ALL information, links, tags, and the author's voice; do not add new content. Output only the rewritten Markdown (including unchanged frontmatter, if any), nothing else.${extra}`;
    case 'tasks':
      return `Extract every action item, to-do, deadline, and follow-up from ${target} as a Markdown task list ("- [ ] ..."). Keep already-completed tasks as "- [x]". Put a due date in the task text if one is mentioned. Output only the list. If there are none, output "_No action items found._"${extra}`;
    case 'links':
      return `Suggest how to connect ${target} to the rest of the vault. Output two sections:\n## Tags\nA single line of 3–8 #tags (prefer tags already used in the vault).\n## Links\nA bullet list of [[existing notes]] from the note list that are genuinely related, each with a short reason. Only use names from the provided note list.${extra}`;
    case 'continue':
      return `Continue writing ${target} from where it ends, in the same style, language and format. Output only the new text to append — do not repeat existing text.${extra}`;
  }
}

export function buildSystemPrompt(ctx: Pick<SkillContext, 'profile'>): string {
  const profile = ctx.profile?.trim();
  return profile
    ? `${SYSTEM}\n\nThe user's own profile and preferences (these override the defaults above where they conflict):\n${fence('user_profile', profile)}`
    : SYSTEM;
}

/** Build the Gemini `contents` array: context turn, prior conversation, current task. */
export function buildContents(ctx: SkillContext): ChatTurn[] {
  const parts: string[] = [];
  if (ctx.path) parts.push(`Current note path: ${ctx.path}`);
  if (ctx.content !== undefined) parts.push(fence('current_note', ctx.content));
  if (ctx.selection?.trim()) parts.push(fence('selected_text', ctx.selection));
  if (ctx.related?.length) {
    parts.push(
      fence('related_notes', ctx.related.map((r) => fence(`note path="${r.path}"`, r.content)).join('\n')),
    );
  }
  if (ctx.noteNames?.length) {
    const names = ctx.noteNames.slice(0, MAX_NOTE_NAMES);
    parts.push(fence('vault_note_names', names.join('\n')));
  }
  if (ctx.tags?.length) parts.push(fence('vault_tags', ctx.tags.map((t) => `#${t}`).join(' ')));
  const context = parts.join('\n\n');
  const task = taskFor(ctx);
  const history = ctx.history ?? [];
  // Context is prepended to the first user turn so follow-up turns in a chat
  // still see the note without duplicating it every turn.
  if (history.length === 0) {
    return [{ role: 'user', text: context ? `${context}\n\n${task}` : task }];
  }
  const [first, ...rest] = history;
  return [
    { role: first!.role, text: first!.role === 'user' && context ? `${context}\n\n${first!.text}` : first!.text },
    ...rest,
    { role: 'user', text: task },
  ];
}
