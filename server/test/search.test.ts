import { describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault/indexer.js';
import { makeVault } from './helpers.js';

describe('search', () => {
  it('finds notes by content and ranks title matches first', async () => {
    const index = new VaultIndex(
      await makeVault({
        'Kubernetes.md': '# Kubernetes\ncluster orchestration',
        'journal.md': 'Today I debugged kubernetes networking for hours.',
        'unrelated.md': 'grocery list',
      }),
    );
    await index.init();
    const results = index.search('kubernetes');
    expect(results.map((r) => r.path)).toContain('journal.md');
    expect(results[0]!.path).toBe('Kubernetes.md');
    expect(results.map((r) => r.path)).not.toContain('unrelated.md');
  });

  it('matches prefixes', async () => {
    const index = new VaultIndex(await makeVault({ 'a.md': 'esphome firmware' }));
    await index.init();
    expect(index.search('esph').map((r) => r.path)).toContain('a.md');
  });

  it('returns [] for empty queries and drops removed notes', async () => {
    const index = new VaultIndex(await makeVault({ 'a.md': 'hello world' }));
    await index.init();
    expect(index.search('  ')).toEqual([]);
    index.removeNote('a.md');
    expect(index.search('hello')).toEqual([]);
  });
});
