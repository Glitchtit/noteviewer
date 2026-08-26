import path from 'node:path';

export class PathError extends Error {}

export function resolveVaultPath(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new PathError(`absolute path not allowed: ${rel}`);
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new PathError(`path escapes vault: ${rel}`);
  }
  return abs;
}
