import { readdirSync } from 'node:fs';
import { dirname, join, posix as pathPosix, resolve } from 'node:path';
import { StaticAssetEntry, StaticAssetHandler } from '@solid/community-server';

const cssModuleRoot = dirname(require.resolve('@solid/community-server/package.json'));

function resolveAssetPath(filePath: string): string {
  if (filePath.startsWith('@css:')) {
    return join(cssModuleRoot, filePath.slice('@css:'.length));
  }
  return resolve(filePath);
}

function stripTrailingSlashes(input: string): string {
  return input.replace(/[\\/]+$/u, '');
}

function ensureUrlTrailingSlash(url: string): string {
  return url.replace(/\/*$/u, '/');
}

function expandFolderAssets(assets: StaticAssetEntry[]): StaticAssetEntry[] {
  const expanded: StaticAssetEntry[] = [];

  for (const asset of assets) {
    // Only expand root folder mappings to explicit files for safety
    // Non-root folders keep catch-all behavior for dynamic file serving
    const isRootFolder = asset.filePath.endsWith('/') && asset.relativeUrl === '/';

    if (!isRootFolder) {
      expanded.push(asset);
      continue;
    }

    const basePath = stripTrailingSlashes(resolveAssetPath(asset.filePath));
    const urlPrefix = ensureUrlTrailingSlash(asset.relativeUrl);

    try {
      const entries = readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          continue;
        }
        if (entry.isFile() || entry.isSymbolicLink()) {
          const relativeUrl = pathPosix.join(urlPrefix, entry.name);
          const absolutePath = join(basePath, entry.name);
          expanded.push(new StaticAssetEntry(relativeUrl, absolutePath));
        }
      }
    } catch (error) {
      throw new Error(`Error expanding static assets from ${basePath}: ${(error as Error).message}`);
    }
  }

  return expanded;
}

/**
 * Static asset handler that automatically expands root folder mappings to explicit files.
 * Non-root folder mappings preserve catch-all behavior for dynamic file serving.
 */
export class PivotStaticAssetHandler extends StaticAssetHandler {
  public constructor(
    assets: StaticAssetEntry[],
    baseUrl: string,
    options: { expires?: number } = {},
  ) {
    const expandedAssets = expandFolderAssets(assets);
    super(expandedAssets, baseUrl, options);
  }
}
