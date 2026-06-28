import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ExmRegistrySource, ExtensionSourceRegistry, LinkExtensionSource, installProjectExtensions, saveExmLock, updateProjectExtensions } from '../src/index.js';
import type { ExmRegistryClient, ExmRegistryLockedPackageRequest, ExmRegistryPackageRequest, ExmVersionRange, ResolvedExmRegistryExtension } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('installProjectExtensions exm registry source', () => {
  it('should install exm registry dependencies into the fixed extensions directory and write lock metadata', async () => {
    /// @case
    /// 1. A project declares an exm registry-backed dependency and package.json exm.registry.
    /// 2. exm install resolves and materializes the dependency.
    /// @expect
    /// The artifact is copied into extensions by dependency id and Raw registry metadata is written to lock v1.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-install-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        registry: 'https://registry.example.com/exm',
        dependencies: {
          'company-tool': 'exm:@company/tool@^1.2.0',
        },
      },
    }));
    const client = new FakeExmRegistryClient([createExmResolution('1.2.3')]);
    const registry = createExmRegistry(client);

    const result = await installProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });
    const targetPath = path.join(projectRoot, 'extensions', 'company-tool');
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      readonly lockFileVersion: number;
      readonly extensions: Record<string, {
        readonly spec: string;
        readonly resolution?: {
          readonly registry?: string;
          readonly packageName?: string;
          readonly version?: string;
          readonly resolved?: string;
          readonly integrity?: string;
          readonly size?: number;
        };
      }>;
    };

    expect(client.requests).toEqual([
      {
        registry: 'https://registry.example.com/exm/',
        packageName: '@company/tool',
        range: '^1.2.0',
        projectRoot,
      },
    ]);
    expect(client.lockedRequests).toEqual([]);
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
      spec: 'exm:@company/tool@^1.2.0',
      resolution: {
        version: '1.2.3',
        integrity: 'sha512-1.2.3',
      },
    });
  });

  it('should rebuild a missing exm registry target from the lockfile without registry resolution', async () => {
    /// @case
    /// 1. A project has an exm registry lock entry but the installed extension directory is missing.
    /// 2. exm install runs again.
    /// @expect
    /// exm uses the locked artifact metadata and does not query the registry index for a new version.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-rebuild-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        registry: 'https://registry.example.com/exm/',
        dependencies: {
          'company-tool': 'exm:@company/tool@^1.2.0',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'exm:@company/tool@^1.2.0',
          resolution: {
            version: '1.2.3',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeExmRegistryClient([]);
    const registry = createExmRegistry(client);

    const result = await installProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });

    expect(client.requests).toEqual([]);
    expect(client.lockedRequests).toEqual([
      {
        registry: 'https://registry.example.com/exm/',
        packageName: '@company/tool',
        version: '1.2.3',
        integrity: 'sha512-1.2.3',
        projectRoot,
      },
    ]);
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

  it('should reject exm registry dependencies without package.json exm.registry', async () => {
    /// @case
    /// 1. A project declares an exm registry dependency but omits package.json exm.registry.
    /// 2. exm install resolves project dependencies.
    /// @expect
    /// Install fails before any remote registry access.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-missing-config-'));
    tempRoots.push(workspace);
    const projectRoot = path.join(workspace, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      exm: {
        dependencies: {
          'company-tool': 'exm:@company/tool@^1.2.0',
        },
      },
    }));
    const client = new FakeExmRegistryClient([]);

    await expect(installProjectExtensions({
      projectRoot,
      registry: createExmRegistry(client),
      cacheRoot: path.join(workspace, 'cache'),
    })).rejects.toThrow('requires package.json exm.registry');
    expect(client.requests).toEqual([]);
    expect(client.lockedRequests).toEqual([]);
  });
});

describe('updateProjectExtensions exm registry source', () => {
  it('should update exm registry range dependencies when the index resolves a newer version', async () => {
    /// @case
    /// 1. A project has an installed exm registry extension locked to an older version.
    /// 2. exm update resolves the same semver range to a newer version.
    /// @expect
    /// The extension directory and lock metadata are updated to the newer artifact version.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-update-'));
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
        registry: 'https://registry.example.com/exm/',
        dependencies: {
          'company-tool': 'exm:@company/tool@^1.2.0',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'exm:@company/tool@^1.2.0',
          resolution: {
            version: '1.2.3',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeExmRegistryClient([createExmResolution('1.2.4')]);
    const registry = createExmRegistry(client);

    const result = await updateProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });
    const lockContent = parse(await readFile(path.join(projectRoot, 'exm-lock.yaml'), 'utf8')) as {
      readonly extensions: Record<string, { readonly resolution?: { readonly version?: string; readonly integrity?: string } }>;
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
    expect(lockContent.extensions['company-tool']?.resolution?.integrity).toBe('sha512-1.2.4');
  });

  it('should skip exact exm registry versions that already match the lockfile', async () => {
    /// @case
    /// 1. A project has an installed exm registry extension locked to the exact requested version.
    /// 2. exm update runs.
    /// @expect
    /// exm does not query the registry index or rewrite the installed extension.
    const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-update-exact-'));
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
        registry: 'https://registry.example.com/exm/',
        dependencies: {
          'company-tool': 'exm:@company/tool@1.2.3',
        },
      },
    }));
    await saveExmLock(projectRoot, {
      lockFileVersion: 1,
      extensions: {
        'company-tool': {
          spec: 'exm:@company/tool@1.2.3',
          resolution: {
            version: '1.2.3',
            integrity: 'sha512-1.2.3',
          },
        },
      },
    });
    const client = new FakeExmRegistryClient([]);
    const registry = createExmRegistry(client);

    const result = await updateProjectExtensions({ projectRoot, registry, cacheRoot: path.join(workspace, 'cache') });

    expect(client.requests).toEqual([]);
    expect(client.lockedRequests).toEqual([
      {
        registry: 'https://registry.example.com/exm/',
        packageName: '@company/tool',
        version: '1.2.3',
        integrity: 'sha512-1.2.3',
        projectRoot,
      },
    ]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(['company-tool']);
    await expect(access(targetPath)).resolves.toBeUndefined();
  });
});

class FakeExmRegistryClient implements ExmRegistryClient {
  public readonly requests: ExmRegistryPackageRequest[] = [];
  public readonly lockedRequests: ExmRegistryLockedPackageRequest[] = [];

  public constructor(private readonly resolutions: ResolvedExmRegistryExtension[]) {}

  public async resolve(request: ExmRegistryPackageRequest): Promise<ResolvedExmRegistryExtension> {
    this.requests.push(request);
    const resolution = this.resolutions.shift();

    if (resolution === undefined) {
      throw new Error('No fake exm registry resolution queued');
    }

    return resolution;
  }

  public async resolveLocked(request: ExmRegistryLockedPackageRequest): Promise<ResolvedExmRegistryExtension> {
    this.lockedRequests.push(request);

    return {
      registry: request.registry,
      packageName: request.packageName,
      version: request.version,
      resolved: `https://artifacts.example.com/exm-artifacts/%40company/tool/${request.version}/extension.tgz`,
      integrity: request.integrity,
    };
  }

  public async extract(resolved: ResolvedExmRegistryExtension, targetPath: string): Promise<void> {
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: resolved.packageName,
      version: resolved.version,
    }));
  }
}

class FakeExmVersionRange implements ExmVersionRange {
  public async satisfies(): Promise<boolean> {
    return true;
  }

  public async maxSatisfying(versions: readonly string[]): Promise<string | undefined> {
    return versions.at(-1);
  }
}

function createExmRegistry(client: FakeExmRegistryClient): ExtensionSourceRegistry {
  return new ExtensionSourceRegistry([
    new LinkExtensionSource(),
    new ExmRegistrySource(client, new FakeExmVersionRange()),
  ]);
}

function createExmResolution(version: string): ResolvedExmRegistryExtension {
  return {
    registry: 'https://registry.example.com/exm/',
    packageName: '@company/tool',
    version,
    resolved: `https://artifacts.example.com/exm-artifacts/%40company/tool/${version}/extension.tgz`,
    integrity: `sha512-${version}`,
    size: Number(version.split('.').at(-1))! + 120,
  };
}
