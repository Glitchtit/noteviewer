import { isHiddenName } from '../vault/files.js';

export function relParam(params: unknown): string {
  const raw = (params as Record<string, string>)['*'] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // Defense-in-depth: Fastify pre-decodes paths; this catches double-encoded sequences like `foo%25ZZ.md`
    return '\u0000invalid';
  }
}

export function badNotePath(rel: string): boolean {
  return rel.includes('\u0000') || rel.split('/').some(isHiddenName) || !rel.endsWith('.md');
}
