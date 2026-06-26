import { access, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { list as listTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { deployExtensionPackage, publishExtensionPackage } from '../src/index.js';
import type { ExmRegistryRemoteClient, PublishCommandOptions, PublishCommandRunner } from '../src/index.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.map(async (workspace) => {
    await rm(workspace, {
      recursive: true,
      force: true,
    });
  }));
  workspaces.length = 0;
});

describe('deployExtensionPackage', () => {
  it('should create only the deploy directory from the workspace root', async () => {
    /// @case
    /// 1. A root package script runs exm deploy from the pnpm workspace root.
    /// 2. The target package has an old .deploy directory.
    /// @expect
    /// exm cleans and regenerates .deploy through pnpm deploy, validates package.json, and does not upload any registry artifact.
    const { packageRoot, workspaceRoot } = await createWorkspace('@feb/extension-sample');
    const staleFile = path.join(packageRoot, '.deploy', 'stale.txt');
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, 'old');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');

    const result = await deployExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: workspaceRoot,
      commandRunner: fake.runner,
    });

    expect(result).toMatchObject({
      packageName: '@feb/extension-sample',
      version: '1.2.3',
      packageRoot,
      workspaceRoot,
      deployDir: path.join(packageRoot, '.deploy'),
    });
    await expect(access(staleFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(packageRoot, '.deploy', 'node_modules', '@feb', 'runtime', 'index.js'))).resolves.toBeUndefined();
    expect(fake.commands).toEqual([
      {
        file: 'pnpm',
        args: [
          '--config.node-linker=hoisted',
          '--filter',
          '@feb/extension-sample',
          '--fail-if-no-match',
          'deploy',
          '--prod',
          '--legacy',
          path.join('packages', 'extension', '.deploy'),
        ],
        cwd: workspaceRoot,
      },
    ]);

    const deployedPackageJson = JSON.parse(await readFile(path.join(packageRoot, '.deploy', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(deployedPackageJson.private).toBe(true);
  });
});

describe('publishExtensionPackage', () => {
  it('should resolve the package from the workspace root and dry-run publish to exm registry', async () => {
    /// @case
    /// 1. A root package script runs exm publish --dry-run from the pnpm workspace root.
    /// 2. The root package name is different from the extension package name.
    /// @expect
    /// exm resolves the target package root, creates a Raw registry artifact locally, validates the index update, and skips remote PUTs.
    const { packageRoot, workspaceRoot } = await createWorkspace('@feb/extension-sample');
    await writePackageJson(workspaceRoot, {
      name: 'workspace-home',
      private: true,
    });
    const staleFile = path.join(packageRoot, '.deploy', 'stale.txt');
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, 'old');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');
    const remote = new FakeRegistryRemoteClient();
    const logMessages: string[] = [];

    const result = await publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: workspaceRoot,
      dryRun: true,
      commandRunner: fake.runner,
      registryClient: remote,
      logger: {
        info: (message: string): void => {
          logMessages.push(message);
        },
      },
    });

    expect(result).toMatchObject({
      packageName: '@feb/extension-sample',
      version: '1.2.3',
      packageRoot,
      workspaceRoot,
      deployDir: path.join(packageRoot, '.deploy'),
      dryRun: true,
      registry: 'https://registry.example.com/repository/exm-registry/',
      indexUrl: 'https://registry.example.com/repository/exm-registry/%40feb/extension-sample/index.json',
      artifactUrl: 'https://registry.example.com/repository/exm-registry/%40feb/extension-sample/1.2.3/extension.tgz',
    });
    expect(result.integrity).toMatch(/^sha512-/);
    expect(result.size).toBeGreaterThan(0);
    expect(logMessages).toContain(`would upload artifact ${result.artifactUrl}`);
    expect(logMessages).toContain(`would update index ${result.indexUrl}`);
    expect(logMessages).toContain(`artifact integrity ${result.integrity}`);
    expect(logMessages).toContain(`artifact size ${result.size}`);
    expect(logMessages).toContain('skip exm registry upload --dry-run');
    await expect(access(staleFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.commands.map((command) => command.file)).toEqual(['pnpm']);
    expect(remote.reads).toEqual(['https://registry.example.com/repository/exm-registry/%40feb/extension-sample/index.json']);
    expect(remote.putFiles).toEqual([]);
    expect(remote.putJsons).toEqual([]);

    const deployedPackageJson = JSON.parse(await readFile(path.join(packageRoot, '.deploy', 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(deployedPackageJson.private).toBe(true);
  });

  it('should upload the complete deploy artifact and index when not dry-run', async () => {
    /// @case
    /// 1. exm publish runs without dry-run mode.
    /// 2. The package version does not already exist in the Raw registry index.
    /// @expect
    /// exm uploads extension.tgz containing node_modules, then uploads an index.json entry pointing at that artifact.
    const { packageRoot } = await createWorkspace('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');
    const remote = new FakeRegistryRemoteClient();

    const result = await publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: packageRoot,
      commandRunner: fake.runner,
      registryClient: remote,
    });

    expect(remote.putFiles).toEqual([
      {
        url: result.artifactUrl,
        contentType: 'application/gzip',
        projectRoot: packageRoot,
      },
    ]);
    expect(remote.putJsons).toHaveLength(1);
    expect(remote.putJsons[0]).toMatchObject({
      url: result.indexUrl,
      projectRoot: packageRoot,
      value: {
        schemaVersion: 1,
        name: '@feb/extension-sample',
        versions: {
          '1.2.3': {
            version: '1.2.3',
            artifact: {
              type: 'tgz',
              path: '1.2.3/extension.tgz',
              integrity: result.integrity,
              size: result.size,
            },
          },
        },
      },
    });
    expect(remote.tarballEntries).toContain('package/package.json');
    expect(remote.tarballEntries).toContain('package/node_modules/@feb/runtime/index.js');
    expect(remote.tarballEntries).toContain('package/node_modules/@feb/runtime/linked.js');
    expect(remote.tarballEntryTypes.get('package/node_modules/@feb/runtime/linked.js')).toBe('File');
  });

  it('should publish prerelease packages as plain exm registry versions', async () => {
    /// @case
    /// 1. pnpm deploy produces a prerelease package version such as 0.0.1-alpha.1.
    /// 2. exm publish uploads to Raw registry.
    /// @expect
    /// The prerelease version is written directly into index.json without npm dist-tag behavior.
    const { packageRoot } = await createWorkspace('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/extension-sample', '0.0.1-alpha.1');
    const remote = new FakeRegistryRemoteClient();

    const result = await publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: packageRoot,
      dryRun: false,
      commandRunner: fake.runner,
      registryClient: remote,
    });

    expect(result.artifactUrl).toBe('https://registry.example.com/repository/exm-registry/%40feb/extension-sample/0.0.1-alpha.1/extension.tgz');
    expect(remote.putJsons[0]?.value).toMatchObject({
      versions: {
        '0.0.1-alpha.1': {
          version: '0.0.1-alpha.1',
          artifact: {
            path: '0.0.1-alpha.1/extension.tgz',
          },
        },
      },
    });
  });

  it('should reject an already published version', async () => {
    /// @case
    /// 1. The Raw registry index already contains the package version being published.
    /// 2. exm publish runs for that same version.
    /// @expect
    /// Publishing fails before uploading the artifact or rewriting the index.
    const { packageRoot } = await createWorkspace('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');
    const remote = new FakeRegistryRemoteClient({
      schemaVersion: 1,
      name: '@feb/extension-sample',
      versions: {
        '1.2.3': {
          version: '1.2.3',
          artifact: {
            type: 'tgz',
            path: '1.2.3/extension.tgz',
            integrity: 'sha512-ZXhpc3Rpbmc=',
            size: 123,
          },
        },
      },
    });

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: packageRoot,
      commandRunner: fake.runner,
      registryClient: remote,
    })).rejects.toThrow('version 1.2.3 already exists');
    expect(remote.putFiles).toEqual([]);
    expect(remote.putJsons).toEqual([]);
  });

  it('should require package.json exm.registry', async () => {
    /// @case
    /// 1. The target package does not declare package.json exm.registry.
    /// 2. exm publish runs after deployment.
    /// @expect
    /// Publishing fails before any Raw registry upload.
    const { packageRoot } = await createWorkspace('@feb/extension-sample', { registry: false });
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');
    const remote = new FakeRegistryRemoteClient();

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: packageRoot,
      commandRunner: fake.runner,
      registryClient: remote,
    })).rejects.toThrow('package.json exm.registry is required');
    expect(remote.putFiles).toEqual([]);
  });

  it('should require a workspace root', async () => {
    /// @case
    /// 1. A package directory is not inside a pnpm workspace.
    /// 2. exm publish is invoked for that package.
    /// @expect
    /// Publishing fails before running external commands.
    const packageRoot = await createLoosePackage('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: packageRoot,
      commandRunner: fake.runner,
      registryClient: new FakeRegistryRemoteClient(),
    })).rejects.toThrow('Unable to find pnpm-workspace.yaml');
    expect(fake.commands).toEqual([]);
  });

  it('should reject an invalid workspace packages field', async () => {
    /// @case
    /// 1. pnpm-workspace.yaml exists but packages is not an array of strings.
    /// 2. exm publish tries to resolve the target package.
    /// @expect
    /// Publishing fails before running pnpm deploy.
    const workspaceRoot = await createTempWorkspaceRoot('packages: 1\n');
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: workspaceRoot,
      commandRunner: fake.runner,
      registryClient: new FakeRegistryRemoteClient(),
    })).rejects.toThrow('pnpm-workspace.yaml packages must be an array of strings');
    expect(fake.commands).toEqual([]);
  });

  it('should reject a package name that is not in the workspace', async () => {
    /// @case
    /// 1. The workspace contains packages but none has the requested package name.
    /// 2. exm publish is invoked with that missing name.
    /// @expect
    /// Publishing fails before pnpm deploy is run.
    const { workspaceRoot } = await createWorkspace('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/missing-extension', '1.2.3');

    await expect(publishExtensionPackage({
      packageName: '@feb/missing-extension',
      cwd: workspaceRoot,
      commandRunner: fake.runner,
      registryClient: new FakeRegistryRemoteClient(),
    })).rejects.toThrow('Unable to find workspace package "@feb/missing-extension"');
    expect(fake.commands).toEqual([]);
  });

  it('should reject duplicate workspace package names', async () => {
    /// @case
    /// 1. Two workspace package.json files use the same package name.
    /// 2. exm publish resolves the package name before deploying.
    /// @expect
    /// Publishing refuses the ambiguous package name.
    const workspaceRoot = await createTempWorkspaceRoot();
    await writePackageJson(path.join(workspaceRoot, 'packages', 'left'), {
      name: '@feb/extension-sample',
      version: '1.2.3',
    });
    await writePackageJson(path.join(workspaceRoot, 'packages', 'right'), {
      name: '@feb/extension-sample',
      version: '1.2.4',
    });
    const fake = createFakePublishCommands('@feb/extension-sample', '1.2.3');

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: workspaceRoot,
      commandRunner: fake.runner,
      registryClient: new FakeRegistryRemoteClient(),
    })).rejects.toThrow('matched multiple package roots');
    expect(fake.commands).toEqual([]);
  });

  it('should reject deploy output with a mismatched package name', async () => {
    /// @case
    /// 1. pnpm deploy produces a package.json for a different package.
    /// 2. exm publish validates the deploy output before publishing.
    /// @expect
    /// Publishing stops before Raw registry access.
    const { workspaceRoot } = await createWorkspace('@feb/extension-sample');
    const fake = createFakePublishCommands('@feb/other-extension', '1.2.3');
    const remote = new FakeRegistryRemoteClient();

    await expect(publishExtensionPackage({
      packageName: '@feb/extension-sample',
      cwd: workspaceRoot,
      dryRun: true,
      commandRunner: fake.runner,
      registryClient: remote,
    })).rejects.toThrow('.deploy/package.json name must match publish package');
    expect(fake.commands.map((command) => command.file)).toEqual(['pnpm']);
    expect(remote.reads).toEqual([]);
  });
});

interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

interface FakePublishCommands {
  readonly commands: RecordedCommand[];
  readonly runner: PublishCommandRunner;
}

interface FakePutFile {
  readonly url: string;
  readonly contentType: string;
  readonly projectRoot: string;
}

interface FakePutJson {
  readonly url: string;
  readonly value: unknown;
  readonly projectRoot: string;
}

class FakeRegistryRemoteClient implements ExmRegistryRemoteClient {
  public readonly reads: string[] = [];
  public readonly putFiles: FakePutFile[] = [];
  public readonly putJsons: FakePutJson[] = [];
  public tarballEntries: string[] = [];
  public tarballEntryTypes = new Map<string, string>();

  public constructor(private readonly index?: unknown) {}

  public async readJson(url: string): Promise<unknown | undefined> {
    this.reads.push(url);
    return this.index;
  }

  public async downloadFile(): Promise<{ integrity: string; size: number }> {
    throw new Error('Unexpected downloadFile');
  }

  public async putFile(url: string, sourcePath: string, contentType: string, projectRoot: string): Promise<void> {
    this.putFiles.push({ url, contentType, projectRoot });
    const tarballEntries = await listTarballEntries(sourcePath);
    this.tarballEntries = tarballEntries.map((entry) => entry.path);
    this.tarballEntryTypes = new Map(tarballEntries.map((entry) => [entry.path, entry.type]));
  }

  public async putJson(url: string, value: unknown, projectRoot: string): Promise<void> {
    this.putJsons.push({ url, value, projectRoot });
  }
}

function createFakePublishCommands(deployedName: string, version: string): FakePublishCommands {
  const fake: FakePublishCommands = {
    commands: [],
    runner: async (file: string, args: readonly string[], options: PublishCommandOptions = {}): Promise<void> => {
      fake.commands.push({
        file,
        args: [...args],
        cwd: options.cwd,
      });

      if (file === 'pnpm') {
        const deployTarget = args.at(-1);
        if (typeof deployTarget !== 'string' || options.cwd === undefined) {
          throw new Error('Expected pnpm deploy target and cwd');
        }

        await writeDeployOutput(path.resolve(options.cwd, deployTarget), deployedName, version);
        return;
      }

      throw new Error(`Unexpected command ${file}`);
    },
  };

  return fake;
}

async function createWorkspace(packageName: string, options: { readonly registry?: boolean } = {}): Promise<{ packageRoot: string; workspaceRoot: string }> {
  const workspaceRoot = await createTempWorkspaceRoot();
  const packageRoot = path.join(workspaceRoot, 'packages', 'extension');
  await writePackageJson(packageRoot, {
    name: packageName,
    version: '1.2.3',
    private: true,
    ...(options.registry === false
      ? {}
      : {
        exm: {
          registry: 'https://registry.example.com/repository/exm-registry',
        },
      }),
  });

  return {
    packageRoot,
    workspaceRoot,
  };
}

async function createLoosePackage(packageName: string): Promise<string> {
  const packageRoot = await mkWorkspaceDirectory('exm-publish-loose-');
  await writePackageJson(packageRoot, {
    name: packageName,
    version: '1.2.3',
    exm: {
      registry: 'https://registry.example.com/repository/exm-registry/',
    },
  });

  return packageRoot;
}

async function createTempWorkspaceRoot(workspaceYaml = 'packages:\n  - packages/*\n'): Promise<string> {
  const workspaceRoot = await mkWorkspaceDirectory('exm-publish-workspace-');
  await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), workspaceYaml);

  return workspaceRoot;
}

async function mkWorkspaceDirectory(prefix: string): Promise<string> {
  const workspace = await (await import('node:fs/promises')).mkdtemp(path.join(tmpdir(), prefix));
  workspaces.push(workspace);

  return workspace;
}

async function writeDeployOutput(deployDir: string, packageName: string, version: string): Promise<void> {
  await mkdir(path.join(deployDir, 'node_modules', '@feb', 'runtime'), { recursive: true });
  await writePackageJson(deployDir, {
    name: packageName,
    version,
    private: true,
    dependencies: {
      '@feb/runtime': '1.0.0',
    },
  });
  await writeFile(path.join(deployDir, 'index.js'), 'export {};\n');
  const runtimePath = path.join(deployDir, 'node_modules', '@feb', 'runtime', 'index.js');
  const runtimeLinkPath = path.join(deployDir, 'node_modules', '@feb', 'runtime', 'linked.js');
  await writeFile(runtimePath, 'export const runtime = true;\n');
  await link(runtimePath, runtimeLinkPath);
}

async function writePackageJson(directory: string, value: object): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(value, null, 2)}\n`);
}

async function listTarballEntries(tarballPath: string): Promise<Array<{ path: string; type: string }>> {
  const entries: Array<{ path: string; type: string }> = [];
  await listTar({
    file: tarballPath,
    onentry: (entry: { path: string; type: string }): void => {
      entries.push({
        path: entry.path,
        type: entry.type,
      });
    },
  });

  return entries;
}
