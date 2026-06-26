import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmExtensionSource, parseNpmSpecifier } from '../src/index.js';
import { loadNpmConfigOptions } from '../src/sources/npm-source.js';
import type { NpmPackageClient, NpmPackageRequest, NpmVersionRange, ResolvedNpmExtension, SourceContext } from '../src/index.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe('parseNpmSpecifier', () => {
  it('should parse scoped and unscoped npm package specs', async () => {
    /// @case
    /// 1. npm source specs include package names and exact or ranged versions.
    /// 2. exm parses the specs before resolving the package from npmrc-backed registry config.
    /// @expect
    /// The npm package name and requested semver range are separated from the exm extension id.
    await expect(parseNpmSpecifier('npm:@company/tool@^1.2.0')).resolves.toEqual({
      packageName: '@company/tool',
      range: '^1.2.0',
    });
    await expect(parseNpmSpecifier('npm:plain-tool@1.2.3')).resolves.toEqual({
      packageName: 'plain-tool',
      range: '1.2.3',
      exactVersion: '1.2.3',
    });
  });

  it('should reject unsupported npm specs', async () => {
    /// @case
    /// 1. npm source specs omit a version, use a dist-tag, or use an npm alias.
    /// 2. exm validates the spec before registry access.
    /// @expect
    /// Unsupported npm forms are rejected so v1 resolution stays deterministic.
    await expect(parseNpmSpecifier('npm:@company/tool')).rejects.toThrow('must include a package name and version range');
    await expect(parseNpmSpecifier('npm:@company/tool@latest')).rejects.toThrow('must not use a dist-tag');
    await expect(parseNpmSpecifier('npm:@company/tool@npm:other@1.0.0')).rejects.toThrow('must not use npm aliases');
  });
});

describe('loadNpmConfigOptions', () => {
  it('should load npmrc registry and auth options through npm config definitions', async () => {
    /// @case
    /// 1. A project .npmrc declares a default registry, a scoped registry, and an env-substituted auth token.
    /// 2. exm loads npm config options for pacote before resolving npm dependencies.
    /// @expect
    /// The npm config loader uses @npmcli/config definitions and exposes flattened registry/auth options without throwing.
    const workspace = await createWorkspace();
    const projectRoot = path.join(workspace, 'project');
    const previousToken = process.env.NPM_TOKEN;
    const previousLowerRegistry = process.env.npm_config_registry;
    const previousUpperRegistry = process.env.NPM_CONFIG_REGISTRY;
    await writeFile(path.join(projectRoot, '.npmrc'), [
      'registry=https://registry.example.test/',
      '@company:registry=https://registry.company.test/',
      '//registry.company.test/:_authToken=${NPM_TOKEN}',
      '',
    ].join('\n'));

    process.env.NPM_TOKEN = 'exm-test-token';
    delete process.env.npm_config_registry;
    delete process.env.NPM_CONFIG_REGISTRY;

    try {
      const options = await loadNpmConfigOptions(projectRoot);

      expect(options.registry).toBe('https://registry.example.test/');
      expect(options['@company:registry']).toBe('https://registry.company.test/');
      expect(options['//registry.company.test/:_authToken']).toBe('exm-test-token');
    } finally {
      if (previousToken === undefined) {
        delete process.env.NPM_TOKEN;
      } else {
        process.env.NPM_TOKEN = previousToken;
      }

      if (previousLowerRegistry === undefined) {
        delete process.env.npm_config_registry;
      } else {
        process.env.npm_config_registry = previousLowerRegistry;
      }

      if (previousUpperRegistry === undefined) {
        delete process.env.NPM_CONFIG_REGISTRY;
      } else {
        process.env.NPM_CONFIG_REGISTRY = previousUpperRegistry;
      }
    }
  });
});

describe('NpmExtensionSource', () => {
  it('should reuse a locked version during install when it satisfies the requested range', async () => {
    /// @case
    /// 1. A project requests an npm range and the lockfile already has a matching npm package version.
    /// 2. exm resolves the dependency for install.
    /// @expect
    /// The npm registry is not queried and the locked tarball metadata is reused.
    const client = new FakeNpmPackageClient([]);
    const source = new NpmExtensionSource(client, new FakeNpmVersionRange(true));
    const context = createContext(await createWorkspace());

    const resolved = await source.resolve({
      id: 'company-tool',
      spec: 'npm:@company/tool@^1.2.0',
      previous: {
        spec: 'npm:@company/tool@^1.2.0',
        resolution: {
          version: '1.2.3',
          resolved: 'https://registry.example.com/tool-1.2.3.tgz',
          integrity: 'sha512-locked',
        },
      },
    }, context);

    expect(client.requests).toEqual([]);
    expect(resolved.npm).toEqual({
      packageName: '@company/tool',
      version: '1.2.3',
      resolved: 'https://registry.example.com/tool-1.2.3.tgz',
      integrity: 'sha512-locked',
    });
  });

  it('should resolve a new version during update for ranged npm specs', async () => {
    /// @case
    /// 1. A project requests an npm range and update is running.
    /// 2. A lockfile version exists but the registry has a newer satisfying package.
    /// @expect
    /// exm asks the npm client to resolve the range instead of reusing the lock.
    const nextResolution = createNpmResolution('1.2.4');
    const client = new FakeNpmPackageClient([nextResolution]);
    const source = new NpmExtensionSource(client, new FakeNpmVersionRange(true));
    const context = {
      ...createContext(await createWorkspace()),
      update: true,
    };

    const resolved = await source.resolve({
      id: 'company-tool',
      spec: 'npm:@company/tool@^1.2.0',
      previous: {
        spec: 'npm:@company/tool@^1.2.0',
        resolution: {
          version: '1.2.3',
          resolved: 'https://registry.example.com/tool-1.2.3.tgz',
        },
      },
    }, context);

    expect(client.requests).toEqual([
      {
        packageName: '@company/tool',
        range: '^1.2.0',
        projectRoot: context.projectRoot,
      },
    ]);
    expect(resolved.npm).toEqual(nextResolution);
  });

  it('should materialize npm packages by extracting cache and copying to extensions', async () => {
    /// @case
    /// 1. An npm package resolves to tarball metadata.
    /// 2. exm materializes the resolved extension.
    /// @expect
    /// The package is extracted once into the npm cache and copied into the fixed extensions directory.
    const workspace = await createWorkspace();
    const context = createContext(workspace);
    const client = new FakeNpmPackageClient([createNpmResolution('1.2.3')]);
    const source = new NpmExtensionSource(client, new FakeNpmVersionRange(true));
    const resolved = await source.resolve({
      id: 'company-tool',
      spec: 'npm:@company/tool@1.2.3',
    }, context);

    const materialized = await source.materialize(resolved, context);

    expect(materialized).toEqual({
      id: 'company-tool',
      path: path.join(context.installRoot, 'company-tool'),
      mode: 'copy',
    });
    expect(client.extracts).toEqual([
      {
        resolved: resolved.npm,
        targetPath: resolved.sourcePath,
        projectRoot: context.projectRoot,
      },
    ]);
    await expect(readFile(path.join(materialized.path, 'package.json'), 'utf8')).resolves.toContain('@company/tool');
  });
});

class FakeNpmPackageClient implements NpmPackageClient {
  public readonly requests: NpmPackageRequest[] = [];
  public readonly extracts: Array<{
    readonly resolved: ResolvedNpmExtension | undefined;
    readonly targetPath: string;
    readonly projectRoot: string;
  }> = [];

  public constructor(private readonly resolutions: ResolvedNpmExtension[]) {}

  public async resolve(request: NpmPackageRequest): Promise<ResolvedNpmExtension> {
    this.requests.push(request);
    const resolution = this.resolutions.shift();

    if (resolution === undefined) {
      throw new Error('No fake npm resolution queued');
    }

    return resolution;
  }

  public async extract(resolved: ResolvedNpmExtension, targetPath: string, projectRoot: string): Promise<void> {
    this.extracts.push({ resolved, targetPath, projectRoot });
    await mkdir(targetPath, { recursive: true });
    await writeFile(path.join(targetPath, 'package.json'), JSON.stringify({
      name: resolved.packageName,
      version: resolved.version,
    }));
  }
}

class FakeNpmVersionRange implements NpmVersionRange {
  public constructor(private readonly result: boolean) {}

  public async satisfies(): Promise<boolean> {
    return this.result;
  }
}

function createNpmResolution(version: string): ResolvedNpmExtension {
  return {
    packageName: '@company/tool',
    version,
    resolved: `https://registry.example.com/tool-${version}.tgz`,
    integrity: `sha512-${version}`,
  };
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'exm-npm-source-'));
  tempRoots.push(workspace);
  await mkdir(path.join(workspace, 'project'), { recursive: true });

  return workspace;
}

function createContext(workspace: string): SourceContext {
  return {
    projectRoot: path.join(workspace, 'project'),
    installRoot: path.join(workspace, 'project', 'extensions'),
    cacheRoot: path.join(workspace, 'project', '.exm', 'cache'),
  };
}
