import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { EXM_LOCAL_FILE, initProjectConfig } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('initProjectConfig', () => {
  it('should initialize package.json exm config', async () => {
    /// @case
    /// 1. A project package.json has no exm field.
    /// 2. exm init is run for shared config.
    /// @expect
    /// package.json receives an exm dependency map and no lockfile is written.
    const projectRoot = await createTempProject({
      name: 'sample-project',
    });

    const result = await initProjectConfig({ projectRoot });
    const packageJson = parseJsonObject(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));

    expect(result).toEqual({
      projectRoot,
      configPath: path.join(projectRoot, 'package.json'),
      local: false,
      status: 'initialized',
    });
    expect(packageJson.exm).toEqual({
      dependencies: {},
    });
    await expect(readFile(path.join(projectRoot, EXM_LOCAL_FILE), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')).rejects.toThrow();
  });

  it('should update existing package.json exm config without replacing dependencies', async () => {
    /// @case
    /// 1. A project has an exm field with existing dependencies but no dependency map default is needed.
    /// 2. exm init is run for shared config.
    /// @expect
    /// Existing dependencies are preserved and no installDir is added.
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {
          sample: 'link:../sample',
        },
      },
    });

    const result = await initProjectConfig({ projectRoot });
    const packageJson = parseJsonObject(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));

    expect(result.status).toBe('unchanged');
    expect(packageJson.exm).toEqual({
      dependencies: {
        sample: 'link:../sample',
      },
    });
  });

  it('should reject package.json exm config with installDir', async () => {
    /// @case
    /// 1. A project still has the removed package.json exm.installDir field.
    /// 2. exm init is run.
    /// @expect
    /// init fails so the user removes the obsolete install directory override.
    const projectRoot = await createTempProject({
      exm: {
        installDir: 'extensions',
        dependencies: {},
      },
    });

    await expect(initProjectConfig({ projectRoot })).rejects.toThrow('package.json exm field installDir is no longer supported');
  });

  it('should initialize exm.local.yaml without changing package.json', async () => {
    /// @case
    /// 1. A project package.json has no exm field.
    /// 2. exm init is run for local config.
    /// @expect
    /// exm.local.yaml receives an empty dependency map and package.json remains unchanged.
    const projectRoot = await createTempProject({
      name: 'sample-project',
    });
    const originalPackageJson = await readFile(path.join(projectRoot, 'package.json'), 'utf8');

    const result = await initProjectConfig({
      projectRoot,
      local: true,
    });
    const localConfig = parse(await readFile(path.join(projectRoot, EXM_LOCAL_FILE), 'utf8')) as unknown;

    expect(result).toEqual({
      projectRoot,
      configPath: path.join(projectRoot, EXM_LOCAL_FILE),
      local: true,
      status: 'initialized',
    });
    expect(localConfig).toEqual({
      dependencies: {},
    });
    await expect(readFile(path.join(projectRoot, 'package.json'), 'utf8')).resolves.toBe(originalPackageJson);
    await expect(readFile(path.join(projectRoot, 'exm-lock.local.yaml'), 'utf8')).rejects.toThrow();
  });

  it('should update existing exm.local.yaml without replacing dependencies', async () => {
    /// @case
    /// 1. A local exm config already has dependencies.
    /// 2. exm init is run for local config.
    /// @expect
    /// Existing local dependencies are preserved and no installDir is added.
    const projectRoot = await createTempProject({});
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      '  localOnly: link:../local-only',
      '',
    ].join('\n'));

    const result = await initProjectConfig({
      projectRoot,
      local: true,
    });
    const localConfig = parse(await readFile(path.join(projectRoot, EXM_LOCAL_FILE), 'utf8')) as unknown;

    expect(result.status).toBe('unchanged');
    expect(localConfig).toEqual({
      dependencies: {
        localOnly: 'link:../local-only',
      },
    });
  });

  it('should reject exm.local.yaml config with installDir', async () => {
    /// @case
    /// 1. A local exm config still has the removed installDir field.
    /// 2. exm init is run for local config.
    /// @expect
    /// init fails so local config cannot silently override the fixed extension root.
    const projectRoot = await createTempProject({});
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'installDir: local-extensions',
      'dependencies: {}',
      '',
    ].join('\n'));

    await expect(initProjectConfig({
      projectRoot,
      local: true,
    })).rejects.toThrow('exm.local.yaml installDir is no longer supported');
  });

  it('should reject invalid package.json exm config', async () => {
    /// @case
    /// 1. package.json exm is not an object.
    /// 2. exm init is run.
    /// @expect
    /// init rejects the invalid config shape.
    const projectRoot = await createTempProject({
      exm: 'bad',
    });

    await expect(initProjectConfig({ projectRoot })).rejects.toThrow('package.json exm field must be an object');
  });

  it('should reject invalid local dependencies', async () => {
    /// @case
    /// 1. exm.local.yaml dependencies is not an object.
    /// 2. exm init is run for local config.
    /// @expect
    /// init rejects the invalid local dependency map.
    const projectRoot = await createTempProject({});
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies: bad',
      '',
    ].join('\n'));

    await expect(initProjectConfig({
      projectRoot,
      local: true,
    })).rejects.toThrow('exm.local.yaml dependencies must be an object');
  });
});

async function createTempProject(packageJson: object): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'exm-init-'));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));

  return root;
}

function parseJsonObject(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}
