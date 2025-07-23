import { access, cp, lstat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { platform } from 'node:os';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

export async function assertDirectory(path: string, label: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;

  try {
    stat = await lstat(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }

  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
}

export async function createDirectoryLink(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await symlink(sourcePath, targetPath, platform() === 'win32' ? 'junction' : 'dir');
}

export async function copyDirectory(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, {
    recursive: true,
    filter: (source): boolean => path.basename(source) !== '.git',
  });
}

export function assertPathInside(parentPath: string, childPath: string, label: string): void {
  const relativePath = path.relative(parentPath, childPath);

  if (relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))) {
    return;
  }

  throw new Error(`${label} must stay inside ${parentPath}: ${childPath}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
