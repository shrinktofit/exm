import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXM_LOCAL_FILE,
  ExtensionSourceRegistry,
  GitExtensionSource,
  LinkExtensionSource,
  saveExmLock,
  updateProjectExtensions,
} from '../src/index.js';

const resolvedCommit = '0123456789abcdef0123456789abcdef01234567';
const oldCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('updateProjectExtensions', () => {
  it('should not create the install directory when there are no dependencies', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-empty-update-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {},
      },
    }));

    const result = await updateProjectExtensions({ projectRoot });

    expect(result.updated).toEqual([]);
    expect(result.adopted).toEqual([]);
    expect(result.skipped).toEqual([]);
    await expect(access(path.join(projectRoot, 'extensions'))).rejects.toThrow();
    await expect(access(path.join(projectRoot, 'exm-lock.yaml'))).rejects.toThrow();
  });

  it('should adopt and pull existing unmanaged git root extensions', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-update-adopt-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(path.join(targetPath, '.git'), { recursive: true });
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

    const result = await updateProjectExtensions({
      projectRoot,
      registry,
    });

    expect(result.updated).toEqual([]);
    expect(result.adopted).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'clone',
        git: {
          commit: resolvedCommit,
        },
      },
    ]);
    expect(calls).toEqual([
      ['pull', '--ff-only'],
      ['rev-parse', 'HEAD'],
    ]);
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).resolves.toContain('lockFileVersion: 1');
  });

  it('should replace existing unmanaged git root targets that cannot be adopted', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-update-replace-'));
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

    const result = await updateProjectExtensions({
      projectRoot,
      registry,
    });

    expect(result.updated).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'clone',
        git: {
          commit: resolvedCommit,
        },
      },
    ]);
    expect(result.adopted).toEqual([]);
    expect(calls).toEqual([
      ['clone', 'https://github.com/feb/example.git', targetPath],
      ['rev-parse', 'HEAD'],
    ]);
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).resolves.toContain('lockFileVersion: 1');
  });

  it('should use the local lockfile when exm.local.yaml adds git dependencies', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-update-local-lock-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {},
      },
    }));
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      '  sample: https://github.com/feb/example.git',
      '',
    ].join('\n'));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        sample: {
          spec: 'https://github.com/feb/example.git',
          commit: oldCommit,
        },
      },
    }, 'exm-lock.local.yaml');
    const registry = new ExtensionSourceRegistry([
      new LinkExtensionSource(),
      new GitExtensionSource(async (file, args) => {
        expect(file).toBe('git');

        if (args[0] === 'rev-parse') {
          return resolvedCommit;
        }
      }),
    ]);

    const result = await updateProjectExtensions({
      projectRoot,
      registry,
    });

    expect(result.updated).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'clone',
        git: {
          commit: resolvedCommit,
        },
      },
    ]);
    await expect(readFile(path.join(projectRoot, 'exm-lock.local.yaml'), 'utf8')).resolves.toContain(`commit: ${resolvedCommit}`);
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).rejects.toThrow();
  });

  it('should pull existing managed git root extensions without a pinned commit', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-update-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: 'https://github.com/feb/example.git',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        sample: {
          spec: 'https://github.com/feb/example.git',
          commit: oldCommit,
        },
      },
    });
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

    const result = await updateProjectExtensions({
      projectRoot,
      registry,
    });

    expect(result.updated).toEqual([
      {
        id: 'sample',
        path: targetPath,
        mode: 'clone',
        git: {
          commit: resolvedCommit,
        },
      },
    ]);
    expect(calls).toEqual([
      ['pull', '--ff-only'],
      ['rev-parse', 'HEAD'],
    ]);
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).resolves.toContain('sample:');
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).resolves.toContain(`commit: ${resolvedCommit}`);
  });

  it('should report no changes when a git update resolves to the locked commit', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-update-unchanged-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'sample');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: 'https://github.com/feb/example.git',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        sample: {
          spec: 'https://github.com/feb/example.git',
          commit: resolvedCommit,
        },
      },
    });
    const registry = new ExtensionSourceRegistry([
      new LinkExtensionSource(),
      new GitExtensionSource(async (file, args) => {
        expect(file).toBe('git');

        if (args[0] === 'rev-parse') {
          return resolvedCommit;
        }
      }),
    ]);

    const result = await updateProjectExtensions({
      projectRoot,
      registry,
    });

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(['sample']);
  });
});
