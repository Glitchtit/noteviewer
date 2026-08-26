import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@noteviewer/shared';
import { resolveLink } from '../src/resolveLink';

const tree: TreeNode = {
  name: '', path: '', type: 'folder',
  children: [
    { name: 'Note.md', path: 'Note.md', type: 'note' },
    {
      name: 'deep', path: 'deep', type: 'folder',
      children: [
        { name: 'Note.md', path: 'deep/Note.md', type: 'note' },
        { name: 'Other.md', path: 'deep/Other.md', type: 'note' },
        { name: 'pic.png', path: 'deep/pic.png', type: 'file' },
      ],
    },
  ],
};

describe('resolveLink', () => {
  it('prefers exact path, then shortest basename match, case-insensitive', () => {
    expect(resolveLink(tree, 'deep/Other')).toBe('deep/Other.md');
    expect(resolveLink(tree, 'Note')).toBe('Note.md');
    expect(resolveLink(tree, 'other')).toBe('deep/Other.md');
    expect(resolveLink(tree, 'Missing')).toBeUndefined();
  });

  it('resolves file embeds by basename', () => {
    expect(resolveLink(tree, 'pic.png')).toBe('deep/pic.png');
  });
});
