import path from 'node:path';

export function safeRelative(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid path');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('Unsafe path');
  return parts.join('/');
}

export function inside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  if (relative === '') return resolvedRoot;
  const safe = safeRelative(relative);
  const resolved = path.resolve(resolvedRoot, safe);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Path escapes session');
  }
  return resolved;
}

export function slug(value: string, fallback = 'item'): string {
  const result = value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60);
  return result || fallback;
}
