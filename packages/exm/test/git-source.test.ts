import { mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitExtensionSource, createGitCacheKey, parseGitSpecifier } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('parseGitSpecifier', () => {
  it('should parse a git url pinned to a commit', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#abcdef1234567890');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      commit: 'abcdef1234567890',
    });
  });

  it('should parse a git url pinned to a commit and extension subpath', () => {
    const parsed = parseGitSpecifier('git+https://github.com/feb/example.git#abcdef1234567890:extensions/example');

    expect(parsed).toEqual({
      url: 'https://github.com/feb/example.git',
      commit: 'abcdef1234567890',
      subpath: 'extensions/example',
    });
  });

  it('should require a commit hash fragment', () => {
    expect(() => parseGitSpecifier('https://github.com/feb/example.git')).toThrow('must include a commit fragment');
  });

  it('should reject branch-like fragments', () => {
    expect(() => parseGitSpecifier('https://github.com/feb/example.git#main')).toThrow('commit hash');
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
      commit: 'abcdef1234567890',
    };

    expect(createGitCacheKey(specifier)).toBe(createGitCacheKey(specifier));
    expect(createGitCacheKey(specifier)).toHaveLength(16);
  });

  it('should share the repository cache across different subpaths', () => {
    const baseSpecifier = {
      url: 'https://github.com/feb/example.git',
      commit: 'abcdef1234567890',
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
    });
    await expect(readFile(path.join(targetPath, 'package.json'), 'utf8')).resolves.toContain('sample-extension');
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
    expect(materialized.mode).toBe('link');
    expect(resolved.reference).toBe('abcdef1:packages/sample-extension');
  });
});
