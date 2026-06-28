import { access, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink as fsSymlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { EXM_LOCAL_FILE, ExtensionSourceRegistry, GitExtensionSource, LinkExtensionSource, installProjectExtensions, saveExmLock } from '../src/index.js';

const resolvedCommit = '0123456789abcdef0123456789abcdef01234567';
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('installProjectExtensions link source', () => {
  it('should not create the install directory when there are no dependencies', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-empty-install-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {},
      },
    }));

    const result = await installProjectExtensions({ projectRoot });

    expect(result.installed).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.skipped).toEqual([]);
    await expect(access(path.join(projectRoot, 'extensions'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, 'exm-lock.yaml'))).rejects.toThrow();
  });

  it('should install a link dependency into the project extension directory', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-link-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ name: 'sample-extension' }));
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: `link:${path.relative(projectRoot, sourceRoot)}`,
        },
      },
    }));

    const result = await installProjectExtensions({ projectRoot });
    const targetPath = path.join(projectRoot, 'extensions', 'sample');

    expect(result.installed).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'link',
      },
    ]);
    expect(await realpath(targetPath)).toBe(await realpath(sourceRoot));
    await expect(readlink(targetPath)).resolves.toBeTruthy();
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).resolves.toContain('sample:');
  });

  it('should install when the link source path is a directory symlink', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-link-source-symlink-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const realSourceRoot = path.join(workspace, 'text-field-extension');
    const sourceLinkRoot = path.join(workspace, 'node_modules', 'cc-extension-text-field');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(realSourceRoot, { recursive: true });
    await mkdir(path.dirname(sourceLinkRoot), { recursive: true });
    await writeFile(path.join(realSourceRoot, 'package.json'), JSON.stringify({ name: 'cc-extension-text-field' }));
    await fsSymlink(realSourceRoot, sourceLinkRoot, 'junction');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'text-field': `link:${path.relative(projectRoot, sourceLinkRoot)}`,
        },
      },
    }));

    const result = await installProjectExtensions({ projectRoot });
    const targetPath = path.join(projectRoot, 'extensions', 'text-field');

    expect(result.installed).toEqual([
      {
        id: 'text-field',
        path: targetPath,
        mode: 'link',
      },
    ]);
    expect(await realpath(targetPath)).toBe(await realpath(realSourceRoot));
    await expect(readlink(targetPath)).resolves.toBeTruthy();
  });

  it('should replace existing unmanaged extension targets and write the lockfile', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-existing-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(targetPath, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: `link:${path.relative(projectRoot, sourceRoot)}`,
        },
      },
    }));

    const result = await installProjectExtensions({ projectRoot });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      lockFileVersion: number;
      extensions: Record<string, { spec: string }>;
    };

    expect(result.installed).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'link',
      },
    ]);
    expect(await realpath(targetPath)).toBe(await realpath(sourceRoot));
    expect(lockContent.lockFileVersion).toBe(1);
    expect(lockContent.extensions.sample?.spec).toBe(`link:${path.relative(projectRoot, sourceRoot)}`);
  });

  it('should write the local lockfile when exm.local.yaml adds dependencies', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-local-lock-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sharedSourceRoot = path.join(workspace, 'shared-extension');
    const localSourceRoot = path.join(workspace, 'local-extension');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sharedSourceRoot, { recursive: true });
    await mkdir(localSourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          shared: `link:${path.relative(projectRoot, sharedSourceRoot)}`,
        },
      },
    }));
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      `  localOnly: link:${path.relative(projectRoot, localSourceRoot).replaceAll('\\', '/')}`,
      '',
    ].join('\n'));

    const result = await installProjectExtensions({ projectRoot });
    const localLockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.local.yaml'), 'utf8')) as {
      extensions: Record<string, { spec: string }>;
    };

    expect(result.installed).toHaveLength(2);
    expect(localLockContent.extensions.shared?.spec).toBe(`link:${path.relative(projectRoot, sharedSourceRoot)}`);
    expect(localLockContent.extensions.localOnly?.spec).toBe(`link:${path.relative(projectRoot, localSourceRoot).replaceAll('\\', '/')}`);
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).rejects.toThrow();
  });

  it('should prune lock entries that are no longer declared during install', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-prune-lock-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    const currentSpec = `link:${path.relative(projectRoot, sourceRoot)}`;
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          current: currentSpec,
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        current: {
          spec: currentSpec,
        },
        stale: {
          spec: 'link:../stale-extension',
        },
      },
    });

    await installProjectExtensions({ projectRoot });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      extensions: Record<string, unknown>;
    };

    expect(Object.keys(lockContent.extensions)).toEqual(['current']);
  });
  it('should replace existing unmanaged git targets and write the lockfile', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-existing-git-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'old.txt'), 'old install');
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: 'https://github.com/feb/example.git',
        },
      },
    }));
    const calls: readonly string[][] = [];
    const registry = new ExtensionSourceRegistry([
      new LinkExtensionSource(),
      new GitExtensionSource(async (file, args) => {
        expect(file).toBe('git');
        (calls as string[][]).push([...args]);

        if (args[0] === 'rev-parse') {
          return resolvedCommit;
        }
      }),
    ]);

    const result = await installProjectExtensions({
      projectRoot,
      registry,
    });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      lockFileVersion: number;
      extensions: Record<string, { spec: string; resolution?: { commit?: string } }>;
    };

    expect(result.installed).toEqual([
      expect.objectContaining({
        id: 'sample',
        path: targetPath,
        mode: 'clone',
        git: {
          commit: resolvedCommit,
        },
        timing: {
          gitSyncMs: expect.any(Number),
        },
      }),
    ]);
    expect(calls).toEqual([
      ['clone', 'https://github.com/feb/example.git', targetPath],
      ['rev-parse', 'HEAD'],
    ]);
    expect(lockContent.lockFileVersion).toBe(1);
    expect(lockContent.extensions.sample?.spec).toBe('https://github.com/feb/example.git');
    expect(lockContent.extensions.sample?.resolution?.commit).toBe(resolvedCommit);
  });

  it('should save resolved commits for branch git dependencies in the lockfile', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-branch-git-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: 'https://github.com/feb/example.git#main',
        },
      },
    }));
    const calls: readonly string[][] = [];
    const registry = new ExtensionSourceRegistry([
      new LinkExtensionSource(),
      new GitExtensionSource(async (file, args) => {
        expect(file).toBe('git');
        (calls as string[][]).push([...args]);

        if (args[0] === 'rev-parse') {
          return resolvedCommit;
        }
      }),
    ]);

    await installProjectExtensions({
      projectRoot,
      registry,
    });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      extensions: Record<string, { spec: string; resolution?: { commit?: string } }>;
    };

    expect(calls).toEqual([
      ['clone', '--no-checkout', 'https://github.com/feb/example.git', targetPath],
      ['fetch', '--depth=1', 'origin', 'main'],
      ['checkout', '--force', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
    ]);
    expect(lockContent.extensions.sample?.spec).toBe('https://github.com/feb/example.git#main');
    expect(lockContent.extensions.sample?.resolution?.commit).toBe(resolvedCommit);
  });

  it('should adopt an existing unmanaged link target when it matches the current spec', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-adopt-link-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: `link:${path.relative(projectRoot, sourceRoot)}`,
        },
      },
    }));
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(path.dirname(targetPath), { recursive: true });
    await fsSymlink(sourceRoot, targetPath, 'junction');

    const result = await installProjectExtensions({ projectRoot });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      lockFileVersion: number;
      extensions: Record<string, { spec: string }>;
    };

    expect(result.installed).toEqual([]);
    expect(result.adopted).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'link',
      },
    ]);
    expect(lockContent.lockFileVersion).toBe(1);
    expect(lockContent.extensions.sample?.spec).toBe(`link:${path.relative(projectRoot, sourceRoot)}`);
  });

  it('should skip existing managed targets when the spec is unchanged', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-skip-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: `link:${path.relative(projectRoot, sourceRoot)}`,
        },
      },
    }));

    await installProjectExtensions({ projectRoot });
    const result = await installProjectExtensions({ projectRoot });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual(['sample']);
  });

  it('should replace existing managed targets when the spec changes', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-replace-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    const nextSourceRoot = path.join(workspace, 'next-extension');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(nextSourceRoot, { recursive: true });
    const writePackageJson = async (sourcePath: string): Promise<void> => {
      await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
        exm: {
          dependencies: {
            sample: `link:${path.relative(projectRoot, sourcePath)}`,
          },
        },
      }));
    };

    await writePackageJson(sourceRoot);
    await installProjectExtensions({ projectRoot });
    await writePackageJson(nextSourceRoot);
    const result = await installProjectExtensions({ projectRoot });
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      extensions: Record<string, { spec: string }>;
    };

    expect(result.installed).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'link',
      },
    ]);
    expect(await realpath(targetPath)).toBe(await realpath(nextSourceRoot));
    expect(lockContent.extensions.sample?.spec).toBe(`link:${path.relative(projectRoot, nextSourceRoot)}`);
  });
});
