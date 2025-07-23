import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installProjectExtensions } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('installProjectExtensions link source', () => {
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
  });

  it('should protect existing extension targets', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-existing-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const sourceRoot = path.join(workspace, 'sample-extension');
    await mkdir(path.join(projectRoot, 'extensions', 'sample'), { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          sample: `link:${path.relative(projectRoot, sourceRoot)}`,
        },
      },
    }));

    await expect(installProjectExtensions({ projectRoot })).rejects.toThrow('already exists');
  });
});
