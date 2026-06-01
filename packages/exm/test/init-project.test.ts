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
    const projectRoot = await createTempProject({
      exm: {
        dependencies: {
          sample: 'link:../sample',
        },
      },
    });

    const result = await initProjectConfig({
      projectRoot,
      installDir: 'editor-extensions',
    });
    const packageJson = parseJsonObject(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));

    expect(result.status).toBe('updated');
    expect(packageJson.exm).toEqual({
      dependencies: {
        sample: 'link:../sample',
      },
      installDir: 'editor-extensions',
    });
  });

  it('should report unchanged when package.json already has exm config', async () => {
    const projectRoot = await createTempProject({
      exm: {
        installDir: 'extensions',
        dependencies: {},
      },
    });

    const result = await initProjectConfig({
      projectRoot,
      installDir: 'extensions',
    });

    expect(result.status).toBe('unchanged');
  });

  it('should initialize exm.local.yaml without changing package.json', async () => {
    const projectRoot = await createTempProject({
      name: 'sample-project',
    });
    const originalPackageJson = await readFile(path.join(projectRoot, 'package.json'), 'utf8');

    const result = await initProjectConfig({
      projectRoot,
      local: true,
      installDir: 'local-extensions',
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
      installDir: 'local-extensions',
    });
    await expect(readFile(path.join(projectRoot, 'package.json'), 'utf8')).resolves.toBe(originalPackageJson);
    await expect(readFile(path.join(projectRoot, 'exm-lock.local.yaml'), 'utf8')).rejects.toThrow();
  });

  it('should update existing exm.local.yaml without replacing dependencies', async () => {
    const projectRoot = await createTempProject({});
    await writeFile(path.join(projectRoot, EXM_LOCAL_FILE), [
      'dependencies:',
      '  localOnly: link:../local-only',
      '',
    ].join('\n'));

    const result = await initProjectConfig({
      projectRoot,
      local: true,
      installDir: 'local-extensions',
    });
    const localConfig = parse(await readFile(path.join(projectRoot, EXM_LOCAL_FILE), 'utf8')) as unknown;

    expect(result.status).toBe('updated');
    expect(localConfig).toEqual({
      dependencies: {
        localOnly: 'link:../local-only',
      },
      installDir: 'local-extensions',
    });
  });

  it('should reject invalid package.json exm config', async () => {
    const projectRoot = await createTempProject({
      exm: 'bad',
    });

    await expect(initProjectConfig({ projectRoot })).rejects.toThrow('package.json exm field must be an object');
  });

  it('should reject invalid local dependencies', async () => {
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
