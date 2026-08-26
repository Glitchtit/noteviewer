import type { TreeNode } from '@noteviewer/shared';

function collect(node: TreeNode, out: string[]): void {
  if (node.type !== 'folder') out.push(node.path);
  for (const c of node.children ?? []) collect(c, out);
}

export function resolveLink(root: TreeNode, target: string): string | undefined {
  const clean = target.split('#')[0]!.split('|')[0]!.trim();
  if (!clean) return undefined;
  const paths: string[] = [];
  collect(root, paths);
  const hasExt = /\.[A-Za-z0-9]+$/.test(clean);
  const wanted = hasExt ? clean : `${clean}.md`;
  const lower = wanted.toLowerCase();
  if (paths.some((p) => p === wanted)) return wanted;
  const matches = paths.filter((p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(`/${lower}`));
  matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matches[0];
}
