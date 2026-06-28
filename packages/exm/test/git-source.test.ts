import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitExtensionSource, createGitCacheKey, parseGitSpecifier } from '../src/index.js';

const resolvedCommit = '0123456789abcdef0123456789abcdef01234567';
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('parseGitSpecifier', () => {
  it('should parse a git url without a pinned commit', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
    });
  });

  it('should parse a git url with a commit ref', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#abcdef1234567890');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      ref: 'abcdef1234567890',
    });
  });

  it('should parse a git url with a commit ref and extension subpath', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#abcdef1234567890:extensions/example');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      ref: 'abcdef1234567890',
      subpath: 'extensions/example',
    });
  });

  it('should parse a git url with a branch ref', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#feature/example:extensions/example');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      ref: 'feature/example',
      subpath: 'extensions/example',
    });
  });

  it('should parse a git url with an extension subpath and no pinned commit', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#:extensions/example');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      subpath: 'extensions/example',
    });
  });

  it('should reject unsafe refs', () => {
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#feature..name')).toThrow('ref must be');
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#bad ref')).toThrow('ref must be');
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#-bad')).toThrow('ref must be');
  });

  it('should reject unsafe extension subpaths', () => {
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#abcdef1:/absolute')).toThrow('subpath must be relative');
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#abcdef1:../escape')).toThrow('subpath must not contain');
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#abcdef1:extensions//sample')).toThrow('subpath must not contain');
  });
});

describe('createGitCacheKey', () => {
  it('should produce stable cache keys', () => {
    const specifier = {
      url: 'https://github.com/feb/example.git',
      ref: 'abcdef1234567890',
    };

    expect(createGitCacheKey(specifier)).toBe(createGitCacheKey(specifier));
    expect(createGitCacheKey(specifier)).toHaveLength(16);
  });

  it('should produce stable cache keys without pinned refs', () => {
    const specifier = {
      url: 'https://github.com/feb/example.git',
    };

    expect(createGitCacheKey(specifier)).toBe(createGitCacheKey(specifier));
    expect(createGitCacheKey(specifier)).toHaveLength(16);
  });

  it('should share the repository cache across different subpaths', () => {
    const baseSpecifier = {
      url: 'https://github.com/feb/example.git',
      ref: 'abcdef1234567890',
    };

    expect(createGitCacheKey({
      ...baseSpecifier,
      subpath: 'extensions/a',
    })).toBe(createGitCacheKey({
      ...baseSpecifier,
      subpath: 'extensions/b',
    }));
  });
});

describe('GitExtensionSource', () => {
  it('should clone repository-root extensions without a pinned ref directly into the target directory', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-git-root-head-'));
    tempRoots.push(workspace);
    const context = {
      projectRoot: path.join(workspace, 'project'),
      installRoot: path.join(workspace, 'project', 'extensions'),
      cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
    };
    await mkdir(context.projectRoot, { recursive: true });
    const targetPath = path.join(context.installRoot, 'sample');
    const calls: readonly string[][] = [];
    const source = new GitExtensionSource(async (file, args) => {
      expect(file).toBe('git');
      (calls as string[][]).push([...args]);

      if (args[0] === 'rev-parse') {
        return resolvedCommit;
      }

      if (args[0] !== 'clone') {
        return;
      }

      expect(args).toEqual(['clone', 'https://github.com/feb/example.git', targetPath]);
      await mkdir(targetPath, { recursive: true });
      await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'sample-extension' }));
    });

    const resolved = await source.resolve({
      id: 'sample',
      spec: 'https://github.com/feb/example.git',
    }, context);
    const materialized = await source.materialize(resolved, context);

    expect(resolved.reference).toBe('HEAD');
    expect(materialized).toEqual({
      id: 'sample',
      path: targetPath,
      mode: 'clone',
      git: {
        commit: resolvedCommit,
      },
      timing: {
        gitSyncMs: expect.any(Number),
      },
    });
    expect(calls).toEqual([
      ['clone', 'https://github.com/feb/example.git', targetPath],
      ['rev-parse', 'HEAD'],
    ]);
    await expect(readFile(path.join(targetPath, 'package.json'), 'utf8')).resolves.toContain('sample-extension');
  });

  it('should clone repository-root extensions directly into the target directory', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-git-root-'));
    tempRoots.push(workspace);
    const context = {
      projectRoot: path.join(workspace, 'project'),
      installRoot: path.join(workspace, 'project', 'extensions'),
      cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
    };
    await mkdir(context.projectRoot, { recursive: true });
    const targetPath = path.join(context.installRoot, 'sample');
    const source = new GitExtensionSource(async (file, args) => {
      expect(file).toBe('git');

      if (args[0] === 'rev-parse') {
        return resolvedCommit;
      }

      if (args[0] !== 'clone') {
        return;
      }

      expect(args.at(-1)).toBe(targetPath);
      await mkdir(targetPath, { recursive: true });
      await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'sample-extension' }));
    });

    const resolved = await source.resolve({
      id: 'sample',
      spec: 'https://github.com/feb/example.git#abcdef1',
    }, context);
    const materialized = await source.materialize(resolved, context);

    expect(resolved.sourcePath).toBe(targetPath);
    expect(materialized).toEqual({
      id: 'sample',
      path: targetPath,
      mode: 'clone',
      git: {
        commit: resolvedCommit,
      },
      timing: {
        gitSyncMs: expect.any(Number),
      },
    });
    await expect(readFile(path.join(targetPath, 'package.json'), 'utf8')).resolves.toContain('sample-extension');
  });

  it('should link an unpinned subdirectory from a cached git checkout', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-git-head-'));
    tempRoots.push(workspace);
    const context = {
      projectRoot: path.join(workspace, 'project'),
      installRoot: path.join(workspace, 'project', 'extensions'),
      cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
    };
    await mkdir(context.projectRoot, { recursive: true });
    const calls: readonly string[][] = [];
    const source = new GitExtensionSource(async (file, args) => {
      expect(file).toBe('git');
      (calls as string[][]).push([...args]);

      if (args[0] === 'rev-parse') {
        return resolvedCommit;
      }

      if (args[0] !== 'clone') {
        return;
      }

      expect(args[1]).toBe('https://github.com/feb/example.git');
      const checkoutPath = args.at(-1);
      expect(checkoutPath).toBeTypeOf('string');
      const extensionPath = path.join(checkoutPath as string, 'packages', 'sample-extension');
      await mkdir(extensionPath, { recursive: true });
      await writeFile(path.join(extensionPath, 'package.json'), JSON.stringify({ name: 'sample-extension' }));
    });

    const resolved = await source.resolve({
      id: 'sample',
      spec: 'https://github.com/feb/example.git#:packages/sample-extension',
    }, context);
    const materialized = await source.materialize(resolved, context);

    await expect(readlink(materialized.path)).resolves.toBeTruthy();
    expect(materialized).toEqual({
      id: 'sample',
      path: path.join(context.installRoot, 'sample'),
      mode: 'link',
      git: {
        commit: resolvedCommit,
      },
      cache: {
        path: path.join(context.cacheRoot, 'git', createGitCacheKey(resolved.git!)),
        hit: false,
      },
      timing: {
        gitSyncMs: expect.any(Number),
        linkMs: expect.any(Number),
      },
    });
    expect(resolved.reference).toBe('HEAD:packages/sample-extension');
    expect(calls[0]?.slice(0, 2)).toEqual(['clone', 'https://github.com/feb/example.git']);
    await expect(readFile(path.join(materialized.path, 'package.json'), 'utf8')).resolves.toContain('sample-extension');
  });

  it('should link a subdirectory from a cached git checkout', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-git-'));
    tempRoots.push(workspace);
    const context = {
      projectRoot: path.join(workspace, 'project'),
      installRoot: path.join(workspace, 'project', 'extensions'),
      cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
    };
    await mkdir(context.projectRoot, { recursive: true });
    const source = new GitExtensionSource(async (file, args) => {
      expect(file).toBe('git');

      if (args[0] === 'rev-parse') {
        return resolvedCommit;
      }

      if (args[0] !== 'clone') {
        return;
      }

      const checkoutPath = args.at(-1);
      expect(checkoutPath).toBeTypeOf('string');
      const extensionPath = path.join(checkoutPath as string, 'packages', 'sample-extension');
      await mkdir(extensionPath, { recursive: true });
      await writeFile(path.join(extensionPath, 'package.json'), JSON.stringify({ name: 'sample-extension' }));
      await writeFile(path.join(checkoutPath as string, 'README.md'), 'repo root');
    });

    const resolved = await source.resolve({
      id: 'sample',
      spec: 'https://github.com/feb/example.git#abcdef1:packages/sample-extension',
    }, context);
    const materialized = await source.materialize(resolved, context);
    const checkoutPath = path.dirname(path.dirname(await realpath(materialized.path)));

    await expect(readFile(path.join(materialized.path, 'package.json'), 'utf8')).resolves.toContain('sample-extension');
    await expect(readFile(path.join(materialized.path, 'README.md'), 'utf8')).rejects.toThrow();
    await expect(readlink(materialized.path)).resolves.toBeTruthy();
    expect(await realpath(materialized.path)).toBe(path.join(checkoutPath, 'packages', 'sample-extension'));
    expect(materialized).toEqual({
      id: 'sample',
      path: path.join(context.installRoot, 'sample'),
      mode: 'link',
      git: {
        commit: resolvedCommit,
      },
      cache: {
        path: path.join(context.cacheRoot, 'git', createGitCacheKey(resolved.git!)),
        hit: false,
      },
      timing: {
        gitSyncMs: expect.any(Number),
        linkMs: expect.any(Number),
      },
    });

    const cachedMaterialized = await source.materialize(resolved, context);

    expect(cachedMaterialized.cache).toEqual({
      path: path.join(context.cacheRoot, 'git', createGitCacheKey(resolved.git!)),
      hit: true,
    });
    expect(cachedMaterialized.timing).toEqual({
      gitSyncMs: expect.any(Number),
      linkMs: expect.any(Number),
    });
    expect(resolved.reference).toBe('abcdef1:packages/sample-extension');
  });
});
