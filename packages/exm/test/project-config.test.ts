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
  it('should read exm dependencies and installDir from package.json', async () => {
    const projectRoot = await createTempProject({
      exm: {
        installDir: 'local-extensions',
        dependencies: {
          sample: 'link:../sample',
        },
      },
    });

    const config = await loadProjectConfig(projectRoot);

    expect(config.projectRoot).toBe(projectRoot);
    expect(config.installDir).toBe('local-extensions');
    expect(config.dependencies).toEqual({
      sample: 'link:../sample',
    });
    expect(config.usesLocalLock).toBe(false);
  });

  it('should default to an empty dependency map', async () => {
    const projectRoot = await createTempProject({});
    const config = await loadProjectConfig(projectRoot);

    expect(config.installDir).toBe('extensions');
    expect(config.dependencies).toEqual({});
    expect(config.usesLocalLock).toBe(false);
  });

  it('should merge exm.local.yaml over package.json exm config', async () => {
    const projectRoot = await createTempProject({
      exm: {
        installDir: 'shared-extensions',
        dependencies: {
          shared: 'https://github.com/feb/shared.git#main',
          overridden: 'https://github.com/feb/original.git#main',
        },
      },
    });
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'installDir: local-extensions',
      'dependencies:',
      '  overridden: link:../local-overridden',
      '  localOnly: link:../local-only',
      '',
    ].join('\n'));

    const config = await loadProjectConfig(projectRoot);

    expect(config.installDir).toBe('local-extensions');
    expect(config.dependencies).toEqual({
      shared: 'https://github.com/feb/shared.git#main',
      overridden: 'link:../local-overridden',
      localOnly: 'link:../local-only',
    });
    expect(config.usesLocalLock).toBe(true);
  });

  it('should keep the shared lock when exm.local.yaml does not change dependencies', async () => {
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
    expect(() => readDependencies({
      '../bad': 'link:../bad',
    })).toThrow('single path segment');
  });

  it('should require string source specifiers', () => {
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
