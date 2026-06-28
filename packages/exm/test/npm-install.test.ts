import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ExtensionSourceRegistry, LinkExtensionSource, NpmExtensionSource, installProjectExtensions, saveExmLock, updateProjectExtensions } from '../src/index.js';
import type { NpmPackageClient, NpmPackageRequest, NpmVersionRange, ResolvedNpmExtension } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('installProjectExtensions npm source', () => {
  it('should install npm dependencies into the fixed extensions directory and write lock metadata', async () => {
    /// @case
    /// 1. A project declares an npm-backed exm dependency.
    /// 2. exm install resolves and materializes the dependency.
    /// @expect
    /// The package is copied into extensions by dependency id and npm metadata is written to lock v1.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-npm-install-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'company-tool': 'npm:@company/tool@^1.2.0',
        },
      },
    }));
    const client = new FakeNpmPackageClient([createNpmResolution('1.2.3')]);
    const registry = createNpmRegistry(client);

    const result = await installProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });
    const targetPath = path.join(projectRoot, 'extensions', 'company-tool');
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      readonly lockFileVersion: number;
      readonly extensions: Record<string, {
        readonly spec: string;
        readonly resolution?: {
          readonly packageName?: string;
          readonly version?: string;
          readonly resolved?: string;
          readonly integrity?: string;
        };
      }>;
    };

    expect(result.installed).toEqual([
      expect.objectContaining({
        id: 'company-tool',
        path: targetPath,
        mode: 'copy',
        cache: expect.objectContaining({
          hit: false,
        }),
      }),
    ]);
    await expect(readFile(path.join(targetPath, 'package.json'), 'utf8')).resolves.toContain('@company/tool');
    expect(lockContent.lockFileVersion).toBe(1);
    expect(lockContent.extensions['company-tool']).toEqual({
      spec: 'npm:@company/tool@^1.2.0',
      resolution: {
        version: '1.2.3',
        resolved: 'https://registry.example.com/tool-1.2.3.tgz',
        integrity: 'sha512-1.2.3',
      },
    });
  });

  it('should rebuild a missing npm target from the lockfile without registry resolution', async () => {
    /// @case
    /// 1. A project has an npm lock entry but the installed extension directory is missing.
    /// 2. exm install runs again.
    /// @expect
    /// exm uses the locked tarball metadata and does not query the registry for a new version.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-npm-rebuild-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'company-tool': 'npm:@company/tool@^1.2.0',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'npm:@company/tool@^1.2.0',
          resolution: {
            version: '1.2.3',
            resolved: 'https://registry.example.com/tool-1.2.3.tgz',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeNpmPackageClient([]);
    const registry = createNpmRegistry(client);

    const result = await installProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });

    expect(client.requests).toEqual([]);
    expect(result.installed).toEqual([
      expect.objectContaining({
        id: 'company-tool',
        path: path.join(projectRoot, 'extensions', 'company-tool'),
        mode: 'copy',
        cache: expect.objectContaining({
          hit: false,
        }),
      }),
    ]);
    await expect(readFile(path.join(projectRoot, 'extensions', 'company-tool', 'package.json'), 'utf8')).resolves.toContain('1.2.3');
  });
});

describe('updateProjectExtensions npm source', () => {
  it('should update npm range dependencies when the registry resolves a newer version', async () => {
    /// @case
    /// 1. A project has an installed npm-backed extension locked to an older version.
    /// 2. exm update resolves the same semver range to a newer version.
    /// @expect
    /// The extension directory and lock metadata are updated to the newer npm package version.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-npm-update-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'company-tool');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: '@company/tool',
      version: '1.2.3',
    }));
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'company-tool': 'npm:@company/tool@^1.2.0',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'npm:@company/tool@^1.2.0',
          resolution: {
            version: '1.2.3',
            resolved: 'https://registry.example.com/tool-1.2.3.tgz',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeNpmPackageClient([createNpmResolution('1.2.4')]);
    const registry = createNpmRegistry(client);

    const result = await updateProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      readonly extensions: Record<string, { readonly resolution?: { readonly version?: string } }>;
    };

    expect(result.updated).toEqual([
      expect.objectContaining({
        id: 'company-tool',
        path: targetPath,
        mode: 'copy',
        cache: expect.objectContaining({
          hit: false,
        }),
      }),
    ]);
    await expect(readFile(path.join(targetPath, 'package.json'), 'utf8')).resolves.toContain('1.2.4');
    expect(lockContent.extensions['company-tool']?.resolution?.version).toBe('1.2.4');
  });

  it('should skip exact npm versions that already match the lockfile', async () => {
    /// @case
    /// 1. A project has an installed npm-backed extension locked to the exact requested version.
    /// 2. exm update runs.
    /// @expect
    /// exm does not query the registry or rewrite the installed extension.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-npm-update-exact-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    const targetPath = path.join(projectRoot, 'extensions', 'company-tool');
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: '@company/tool',
      version: '1.2.3',
    }));
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'company-tool': 'npm:@company/tool@1.2.3',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'npm:@company/tool@1.2.3',
          resolution: {
            version: '1.2.3',
            resolved: 'https://registry.example.com/tool-1.2.3.tgz',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeNpmPackageClient([]);
    const registry = createNpmRegistry(client);

    const result = await updateProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });

    expect(client.requests).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(['company-tool']);
    await expect(access(targetPath)).resolves.toBeUndefined();
  });
});

class FakeNpmPackageClient implements NpmPackageClient {
  public readonly requests: NpmPackageRequest[] = [];

  public constructor(private readonly resolutions: ResolvedNpmExtension[]) {}

  public async resolve(request: NpmPackageRequest): Promise<ResolvedNpmExtension> {
    this.requests.push(request);
    const resolution = this.resolutions.shift();

    if (resolution === undefined) {
      throw new Error('No fake npm resolution queued');
    }

    return resolution;
  }

  public async extract(resolved: ResolvedNpmExtension, targetPath: string): Promise<void> {
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: resolved.packageName,
      version: resolved.version,
    }));
  }
}

class FakeNpmVersionRange implements NpmVersionRange {
  public async satisfies(): Promise<boolean> {
    return true;
  }
}

function createNpmRegistry(client: FakeNpmPackageClient): ExtensionSourceRegistry {
  return new ExtensionSourceRegistry([
    new LinkExtensionSource(),
    new NpmExtensionSource(client, new FakeNpmVersionRange()),
  ]);
}

function createNpmResolution(version: string): ResolvedNpmExtension {
  return {
    packageName: '@company/tool',
    version,
    resolved: `https://registry.example.com/tool-${version}.tgz`,
    integrity: `sha512-${version}`,
  };
}
