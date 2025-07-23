import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectConfig, readDependencies } from '../src/index.js';

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
  });

  it('should default to an empty dependency map', async () => {
    const projectRoot = await createTempProject({});
    const config = await loadProjectConfig(projectRoot);

    expect(config.installDir).toBe('extensions');
    expect(config.dependencies).toEqual({});
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
