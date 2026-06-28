import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const EXM_CACHE_ENV = 'EXM_CACHE_ROOT';

export function resolveExmCacheRoot(projectRoot: string, configuredCacheRoot?: string): string {
  const cacheRoot = configuredCacheRoot ?? process.env[EXM_CACHE_ENV];

  if (cacheRoot !== undefined && cacheRoot.length > 0) {
    return path.resolve(projectRoot, cacheRoot);
  }

  const home = homedir();

  if (home.length === 0) {
    return path.join(projectRoot, '.exm', 'cache');
  }

  return path.join(home, '.exm', 'cache');
}
