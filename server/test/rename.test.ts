import { describe, expect, it } from 'vitest';
import { rewriteLinks } from '../src/vault/rename.js';

describe('rewriteLinks', () => {
  it('rewrites plain, aliased, and heading links', () => {
    const input = 'See [[Old]], [[Old|the alias]], [[Old#Section]].';
    expect(rewriteLinks(input, 'Old', 'New')).toBe(
      'See [[New]], [[New|the alias]], [[New#Section]].',
    );
  });

  it('does not touch links that merely share a prefix, or plain text', () => {
    const input = '[[Older]] notes mention Old habits.';
    expect(rewriteLinks(input, 'Old', 'New')).toBe(input);
  });

  it('escapes regex metacharacters in names', () => {
    expect(rewriteLinks('link [[C++ (notes)]]', 'C++ (notes)', 'Cpp')).toBe('link [[Cpp]]');
  });
});
