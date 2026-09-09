import type { ResourceIdentifier } from '@solid/community-server';

/**
 * CSS internal storage (locks, IDP adapter, ...) lives under `/.internal/`.
 *
 * IMPORTANT: `ResourceIdentifier.path` is the full canonical URL (e.g.
 * `https://pod.example.org/.internal/...`), not a bare path — identifier
 * strategies (e.g. `SubdomainIdentifierStrategy`) test it against URL regexes.
 * We must extract the URL pathname before comparing, otherwise the check never
 * matches. This works in both suffix and subdomain deployment modes.
 */
export function isInternalPath(identifier: ResourceIdentifier): boolean {
  let path = identifier.path;
  try {
    path = new URL(identifier.path).pathname;
  } catch {
    // Not a parseable URL — use the raw path as-is.
  }
  return path === '/.internal' || path.startsWith('/.internal/');
}
