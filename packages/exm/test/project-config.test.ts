import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXM_LOCAL_FILE, loadProjectConfig, readDependencies } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('loadProjectConfig', () => {
  it('should read exm dependencies from package.json', async () => {
    /// @case
    /// 1. A project declares exm dependencies in package.json.
    /// 2. No local exm config exists.
    /// @expect
    /// The shared dependency map is loaded without switching to a local lockfile.
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {
          sample: 'link:../sample',
        },
      },
    });

    const config = await loadProjectConfig(projectRoot);

    expect(config.projectRoot).toBe(projectRoot);
    expect(config.dependencies).toEqual({
      sample: 'link:../sample',
    });
    expect(config.usesLocalLock).toBe(false);
  });

  it('should default to an empty dependency map', async () => {
    /// @case
    /// 1. A project has no exm config.
    /// 2. The project config is loaded.
    /// @expect
    /// exm uses an empty dependency map and the shared lockfile.
    const projectRoot = await createTempProject({});
    const config = await loadProjectConfig(projectRoot);

    expect(config.dependencies).toEqual({});
    expect(config.usesLocalLock).toBe(false);
  });

  it('should read package.json exm.registry as a normalized URL', async () => {
    /// @case
    /// 1. A project declares an exm Raw registry base URL in package.json.
    /// 2. The project config is loaded.
    /// @expect
    /// The registry URL is normalized with a trailing slash for exm registry source resolution.
    const projectRoot = await createTempProject({
      exm: {
        registry: 'https://registry.example.com/repository/exm-registry',
        dependencies: {},
      },
    });

    const config = await loadProjectConfig(projectRoot);

    expect(config.registry).toBe('https://registry.example.com/repository/exm-registry/');
  });

  it('should reject exm.local.yaml registry', async () => {
    /// @case
    /// 1. A local exm config declares registry.
    /// 2. The project config is loaded.
    /// @expect
    /// exm rejects local registry overrides because v1 only supports package.json exm.registry.
    const projectRoot = await createTempProject({
      exm: {
        registry: 'https://registry.example.com/repository/exm-registry/',
        dependencies: {},
      },
    });
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'registry: https://local.example.com/exm/',
      'dependencies: {}',
      '',
    ].join('\n'));

    await expect(loadProjectConfig(projectRoot)).rejects.toThrow('exm.local.yaml registry is not supported');
  });

  it('should reject package.json exm.installDir', async () => {
    /// @case
    /// 1. A project still declares the removed package.json exm.installDir field.
    /// 2. The project config is loaded.
    /// @expect
    /// exm rejects the legacy field because extensions now always install into extensions.
    const projectRoot = await createTempProject({
      exm: {
        installDir: 'local-extensions',
        dependencies: {},
      },
    });

    await expect(loadProjectConfig(projectRoot)).rejects.toThrow('package.json exm.installDir is no longer supported');
  });

  it('should reject exm.local.yaml installDir', async () => {
    /// @case
    /// 1. A local exm config still declares the removed installDir field.
    /// 2. The project config is loaded.
    /// @expect
    /// exm rejects the legacy local field instead of silently changing install roots.
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {},
      },
    });
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'installDir: local-extensions',
      'dependencies: {}',
      '',
    ].join('\n'));

    await expect(loadProjectConfig(projectRoot)).rejects.toThrow('exm.local.yaml installDir is no longer supported');
  });

  it('should merge exm.local.yaml over package.json exm config', async () => {
    /// @case
    /// 1. Shared config declares dependencies.
    /// 2. Local config overrides one dependency and adds another.
    /// @expect
    /// The merged dependency map uses local values and switches to a local lockfile.
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {
          shared: 'https://github.com/feb/shared.git#main',
          overridden: 'https://github.com/feb/original.git#main',
        },
      },
    });
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      '  overridden: link:../local-overridden',
      '  localOnly: link:../local-only',
      '',
    ].join('\n'));

    const config = await loadProjectConfig(projectRoot);

    expect(config.dependencies).toEqual({
      shared: 'https://github.com/feb/shared.git#main',
      overridden: 'link:../local-overridden',
      localOnly: 'link:../local-only',
    });
    expect(config.usesLocalLock).toBe(true);
  });

  it('should keep the shared lock when exm.local.yaml does not change dependencies', async () => {
    /// @case
    /// 1. Local config repeats the shared dependency value exactly.
    /// 2. The project config is loaded.
    /// @expect
    /// The dependency map is unchanged and exm keeps using the shared lockfile.
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {
          sample: 'link:../sample',
        },
      },
    });
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      '  sample: link:../sample',
      '',
    ].join('\n'));

    const config = await loadProjectConfig(projectRoot);

    expect(config.dependencies).toEqual({
      sample: 'link:../sample',
    });
    expect(config.usesLocalLock).toBe(false);
  });
});

describe('readDependencies', () => {
  it('should reject dependency ids that escape the extension directory', () => {
    /// @case
    /// 1. A dependency id contains a parent-directory segment.
    /// 2. Dependencies are read from config.
    /// @expect
    /// exm rejects ids that cannot map to one extension directory name.
    expect(() => readDependencies({
      '../bad': 'link:../bad',
    })).toThrow('single path segment');
  });

  it('should require string source specifiers', () => {
    /// @case
    /// 1. A dependency specifier is not a string.
    /// 2. Dependencies are read from config.
    /// @expect
    /// exm rejects non-string source specifiers.
    expect(() => readDependencies({
      sample: 1,
    })).toThrow('must use a string');
  });
});

async function createTempProject(packageJson: object): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'exm-config-'));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));

  return root;
}
