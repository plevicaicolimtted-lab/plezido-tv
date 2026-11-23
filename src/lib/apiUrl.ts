const QUERY_API_BASE =
  typeof window !== 'undefined'
    ? (new URLSearchParams(window.location.search).get('api') ?? '').trim().replace(/\/+$/, '')
    : '';

let resolvedBase = QUERY_API_BASE;

export function setResolvedApiBase(base: string): void {
  resolvedBase = base.trim().replace(/\/+$/, '');
}

export function getConfiguredFallbackApiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() ?? '';
  return raw.replace(/\/+$/, '');
}

export function apiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!resolvedBase) return normalizedPath;
  return `${resolvedBase}${normalizedPath}`;
}
