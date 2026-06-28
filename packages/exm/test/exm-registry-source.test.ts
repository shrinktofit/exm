import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExmRegistrySource, HttpExmRegistryClient, createExmPackageMetadataUrl, normalizeExmPackageMetadata, parseExmRegistrySpecifier } from '../src/index.js';
import type { ExmRegistryClient, ExmRegistryLockedPackageRequest, ExmRegistryPackageRequest, ExmRegistryRemoteClient, ExmVersionRange, ResolvedExmRegistryExtension, SourceContext } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('parseExmRegistrySpecifier', () => {
  it('should parse scoped and unscoped exm registry specs', async () => {
    /// @case
    /// 1. exm registry specs include package names and exact or ranged versions.
    /// 2. exm parses the specs before reading registry metadata.
    /// @expect
    /// The package name and semver range are separated from the extension id.
    await expect(parseExmRegistrySpecifier('exm:@company/tool@^1.2.0')).resolves.toEqual({
      packageName: '@company/tool',
      range: '^1.2.0',
    });
    await expect(parseExmRegistrySpecifier('exm:plain-tool@1.2.3')).resolves.toEqual({
      packageName: 'plain-tool',
      range: '1.2.3',
      exactVersion: '1.2.3',
    });
  });

  it('should reject unsupported exm registry specs', async () => {
    /// @case
    /// 1. exm registry specs omit a version, use a dist-tag, or use an invalid package name.
    /// 2. exm validates the spec before registry access.
    /// @expect
    /// Unsupported forms are rejected so registry resolution stays deterministic.
    await expect(parseExmRegistrySpecifier('exm:@company/tool')).rejects.toThrow('must include a package name and version range');
    await expect(parseExmRegistrySpecifier('exm:@company/tool@latest')).rejects.toThrow('must not use a dist-tag');
    await expect(parseExmRegistrySpecifier('exm:@company/:bad@1.0.0')).rejects.toThrow('package name is invalid');
  });
});

describe('exm npm-compatible package metadata', () => {
  it('should build and normalize package metadata', () => {
    /// @case
    /// 1. The registry server exposes npm-compatible package metadata.
    /// 2. exm normalizes that metadata before resolving artifact tarballs.
    /// @expect
    /// The scoped package metadata URL is npm-compatible and artifact metadata stays available under exm.artifact.
    expect(createExmPackageMetadataUrl('https://registry.example.com/exm/', '@company/tool')).toBe('https://registry.example.com/exm/%40company/tool');
    expect(normalizeExmPackageMetadata(createPackageMetadata(), '@company/tool', 'metadata')).toMatchObject({
      name: '@company/tool',
      versions: {
        '1.2.3': {
          dist: {
            tarball: 'https://registry.example.com/exm/%40company/tool/1.2.3/extension.tgz',
            integrity: 'sha512-aaaaaaaa',
          },
          exm: {
            artifact: {
              type: 'tgz',
              path: '1.2.3/extension.tgz',
              size: 123,
            },
          },
        },
      },
    });
  });

  it('should reject invalid package metadata', () => {
    /// @case
    /// 1. The registry server returns metadata without npm dist.tarball or exm artifact metadata.
    /// 2. exm validates it before installing.
    /// @expect
    /// Invalid metadata is rejected instead of guessing a Nexus URL.
    expect(() => normalizeExmPackageMetadata({ name: '@company/tool', versions: { '1.2.3': { name: '@company/tool', version: '1.2.3' } } }, '@company/tool', 'metadata')).toThrow('dist must be an object');
  });
});

describe('ExmRegistrySource', () => {
  it('should reuse a locked version during install when it satisfies the requested range', async () => {
    /// @case
    /// 1. A project requests an exm registry range and the lockfile has a matching artifact.
    /// 2. exm resolves the dependency for install.
    /// @expect
    /// exm does not choose a newer version and asks the client for the locked version metadata.
    const client = new FakeExmRegistryClient([]);
    const source = new ExmRegistrySource(client, new FakeExmVersionRange(true));
    const context = createContext(await createWorkspace());

    const resolved = await source.resolve({
      id: 'company-tool',
      spec: 'exm:@company/tool@^1.2.0',
      previous: {
        spec: 'exm:@company/tool@^1.2.0',
        resolution: {
          version: '1.2.3',
          integrity: 'sha512-locked',
        },
      },
    }, context);

    expect(client.requests).toEqual([]);
    expect(client.lockedRequests).toEqual([
      {
        registry: 'https://registry.example.com/exm/',
        packageName: '@company/tool',
        version: '1.2.3',
        integrity: 'sha512-locked',
        projectRoot: context.projectRoot,
      },
    ]);
    expect(resolved.exm).toEqual({
      registry: 'https://registry.example.com/exm/',
      packageName: '@company/tool',
      version: '1.2.3',
      resolved: 'https://registry.example.com/exm/%40company/tool/1.2.3/extension.tgz',
      integrity: 'sha512-locked',
    });
  });

  it('should require package.json exm.registry for exm registry specs', async () => {
    /// @case
    /// 1. A project requests an exm registry dependency without configuring exm.registry.
    /// 2. exm resolves the dependency.
    /// @expect
    /// Resolution fails before accessing any remote registry.
    const source = new ExmRegistrySource(new FakeExmRegistryClient([]), new FakeExmVersionRange(true));
    const context = {
      ...createContext(await createWorkspace()),
      exmRegistry: undefined,
    };

    await expect(source.resolve({
      id: 'company-tool',
      spec: 'exm:@company/tool@^1.2.0',
    }, context)).rejects.toThrow('requires package.json exm.registry');
  });

  it('should materialize exm registry artifacts by extracting cache and copying to extensions', async () => {
    /// @case
    /// 1. An exm registry package resolves to artifact metadata.
    /// 2. exm materializes the resolved extension.
    /// @expect
    /// The artifact is extracted once into the exm cache and copied into the fixed extensions directory.
    const workspace = await createWorkspace();
    const context = createContext(workspace);
    const client = new FakeExmRegistryClient([createExmResolution('1.2.3')]);
    const source = new ExmRegistrySource(client, new FakeExmVersionRange(true));
    const resolved = await source.resolve({
      id: 'company-tool',
      spec: 'exm:@company/tool@1.2.3',
    }, context);

    const materialized = await source.materialize(resolved, context);

    expect(materialized).toEqual({
      id: 'company-tool',
      path: path.join(context.installRoot, 'company-tool'),
      mode: 'copy',
      cache: {
        path: resolved.sourcePath,
        hit: false,
      },
      timing: {
        cachePopulateMs: expect.any(Number),
        cacheCopyMs: expect.any(Number),
      },
    });
    expect(client.extracts).toEqual([
      {
        resolved: resolved.exm,
        targetPath: resolved.sourcePath,
        projectRoot: context.projectRoot,
      },
    ]);
    await expect(readFile(path.join(materialized.path, 'package.json'), 'utf8')).resolves.toContain('@company/tool');

    const cachedMaterialized = await source.materialize(resolved, context);

    expect(cachedMaterialized.cache).toEqual({
      path: resolved.sourcePath,
      hit: true,
    });
    expect(cachedMaterialized.timing).toEqual({
      cacheCopyMs: expect.any(Number),
    });
    expect(client.extracts).toHaveLength(1);
  });
});

describe('HttpExmRegistryClient', () => {
  it('should resolve the highest version satisfying the requested range from package metadata', async () => {
    /// @case
    /// 1. A registry server package metadata document contains multiple versions.
    /// 2. exm resolves a ranged dependency.
    /// @expect
    /// The highest semver version satisfying the range is selected from npm-compatible metadata.
    const metadataUrl = 'https://registry.example.com/exm/%40company/tool';
    const remote = new FakeRemoteClient({
      [metadataUrl]: createPackageMetadata({
        '1.2.3': createPackageVersion('1.2.3', 'sha512-aaaaaaaa'),
        '1.2.4': createPackageVersion('1.2.4', 'sha512-bbbbbbbb'),
        '2.0.0': createPackageVersion('2.0.0', 'sha512-cccccccc'),
      }),
    });
    const client = new HttpExmRegistryClient(remote);

    const resolved = await client.resolve({
      registry: 'https://registry.example.com/exm',
      packageName: '@company/tool',
      range: '^1.2.0',
      projectRoot: 'project',
    });

    expect(remote.reads).toEqual([metadataUrl]);
    expect(resolved).toEqual({
      registry: 'https://registry.example.com/exm/',
      packageName: '@company/tool',
      version: '1.2.4',
      resolved: 'https://registry.example.com/exm/%40company/tool/1.2.4/extension.tgz',
      integrity: 'sha512-bbbbbbbb',
      size: 124,
    });
  });

  it('should resolve a locked version from package metadata without selecting a newer version', async () => {
    /// @case
    /// 1. A lockfile pins an older version that still exists in registry metadata.
    /// 2. exm rebuilds a missing extension target.
    /// @expect
    /// The locked version tarball is used and no range resolution to the newer version occurs.
    const metadataUrl = 'https://registry.example.com/exm/%40company/tool';
    const remote = new FakeRemoteClient({
      [metadataUrl]: createPackageMetadata({
        '1.2.3': createPackageVersion('1.2.3', 'sha512-aaaaaaaa'),
        '1.2.4': createPackageVersion('1.2.4', 'sha512-bbbbbbbb'),
      }),
    });
    const client = new HttpExmRegistryClient(remote);

    const resolved = await client.resolveLocked({
      registry: 'https://registry.example.com/exm',
      packageName: '@company/tool',
      version: '1.2.3',
      integrity: 'sha512-aaaaaaaa',
      projectRoot: 'project',
    });

    expect(remote.reads).toEqual([metadataUrl]);
    expect(resolved.version).toBe('1.2.3');
    expect(resolved.resolved).toBe('https://registry.example.com/exm/%40company/tool/1.2.3/extension.tgz');
  });

  it('should require package metadata before resolving package versions', async () => {
    /// @case
    /// 1. A project points at an exm registry server without the package metadata document.
    /// 2. exm resolves an exm dependency.
    /// @expect
    /// Resolution fails instead of deriving an internal Nexus URL.
    const metadataUrl = 'https://registry.example.com/exm/%40company/tool';
    const remote = new FakeRemoteClient({});
    const client = new HttpExmRegistryClient(remote);

    await expect(client.resolve({
      registry: 'https://registry.example.com/exm',
      packageName: '@company/tool',
      range: '^1.2.0',
      projectRoot: 'project',
    })).rejects.toThrow(`was not found at ${metadataUrl}`);
    expect(remote.reads).toEqual([metadataUrl]);
  });
});

class FakeExmRegistryClient implements ExmRegistryClient {
  public readonly requests: ExmRegistryPackageRequest[] = [];
  public readonly lockedRequests: ExmRegistryLockedPackageRequest[] = [];
  public readonly extracts: Array<{
    readonly resolved: ResolvedExmRegistryExtension | undefined;
    readonly targetPath: string;
    readonly projectRoot: string;
  }> = [];

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
      resolved: `https://registry.example.com/exm/%40company/tool/${request.version}/extension.tgz`,
      integrity: request.integrity,
    };
  }

  public async extract(resolved: ResolvedExmRegistryExtension, targetPath: string, projectRoot: string): Promise<void> {
    this.extracts.push({ resolved, targetPath, projectRoot });
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: resolved.packageName,
      version: resolved.version,
    }));
  }
}

class FakeExmVersionRange implements ExmVersionRange {
  public constructor(private readonly result: boolean) {}

  public async satisfies(): Promise<boolean> {
    return this.result;
  }

  public async maxSatisfying(versions: readonly string[]): Promise<string | undefined> {
    return versions.at(-1);
  }
}

class FakeRemoteClient implements ExmRegistryRemoteClient {
  public readonly reads: string[] = [];

  public constructor(private readonly responses: Readonly<Record<string, unknown | undefined>>) {}

  public async readJson(url: string): Promise<unknown | undefined> {
    this.reads.push(url);
    return this.responses[url];
  }

  public async downloadFile(): Promise<{ integrity: string; size: number }> {
    throw new Error('Unexpected downloadFile');
  }
}

function createExmResolution(version: string): ResolvedExmRegistryExtension {
  return {
    registry: 'https://registry.example.com/exm/',
    packageName: '@company/tool',
    version,
    resolved: `https://registry.example.com/exm/%40company/tool/${version}/extension.tgz`,
    integrity: `sha512-${version}`,
    size: 100,
  };
}

function createPackageMetadata(versions: Record<string, object> = { '1.2.3': createPackageVersion('1.2.3', 'sha512-aaaaaaaa') }): object {
  return {
    'name': '@company/tool',
    'versions': versions,
    'dist-tags': {
      latest: Object.keys(versions).at(-1),
    },
    'exm': {
      schemaVersion: 1,
    },
  };
}

function createPackageVersion(version: string, integrity: string): object {
  return {
    name: '@company/tool',
    version,
    dist: {
      tarball: `https://registry.example.com/exm/%40company/tool/${version}/extension.tgz`,
      integrity,
    },
    exm: {
      artifact: {
        type: 'tgz',
        path: `${version}/extension.tgz`,
        integrity,
        size: Number(version.split('.').at(-1))! + 120,
      },
    },
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'exm-registry-source-'));
  tempRoots.push(workspace);
  await mkdir(path.join(workspace, 'project'), { recursive: true });

  return workspace;
}

function createContext(workspace: string): SourceContext {
  return {
    projectRoot: path.join(workspace, 'project'),
    installRoot: path.join(workspace, 'project', 'extensions'),
    cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
    exmRegistry: 'https://registry.example.com/exm/',
  };
}
