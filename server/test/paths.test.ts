import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PathError, resolveVaultPath } from '../src/vault/paths.js';

const root = '/data/vault';

describe('resolveVaultPath', () => {
  it('resolves a nested relative path inside the root', () => {
    expect(resolveVaultPath(root, 'folder/note.md')).toBe(
      path.resolve(root, 'folder/note.md'),
    );
  });

  it('rejects absolute paths', () => {
    expect(() => resolveVaultPath(root, '/etc/passwd')).toThrow(PathError);
  });

  it('rejects .. escapes, including sneaky ones', () => {
    expect(() => resolveVaultPath(root, '../secret.md')).toThrow(PathError);
    expect(() => resolveVaultPath(root, 'a/../../secret.md')).toThrow(PathError);
  });

  it('allows the root itself via empty string', () => {
    expect(resolveVaultPath(root, '')).toBe(path.resolve(root));
  });
});
