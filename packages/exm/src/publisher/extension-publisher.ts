import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack as packTar } from 'tar-fs';
import { glob } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';
import { isJsonObject, readJsonObject } from '../config/package-json.js';
import { assertDirectory, assertPathInside, pathExists } from '../fs/path.js';
import { NpmRegistryFetchRemoteClient, createEmptyExmRegistryIndex, createExmRegistryArtifactPath, createExmRegistryArtifactUrl, createExmRegistryIndexUrl, createSha512IntegrityFromFile, normalizeExmRegistryIndex, normalizeExmRegistryUrl } from '../sources/exm-registry-source.js';
import type { JsonObject } from '../config/package-json.js';
import type { ExmRegistryIndex, ExmRegistryRemoteClient } from '../sources/exm-registry-source.js';

const WORKSPACE_FILE = 'pnpm-workspace.yaml';
const DEPLOY_DIR_NAME = '.deploy';

export interface DeployExtensionPackageOptions {
  readonly packageName: string;
  readonly cwd?: string;
  readonly logger?: Pick<Console, 'info'>;
  readonly commandRunner?: PublishCommandRunner;
}

export interface DeployExtensionPackageResult {
  readonly packageName: string;
  readonly version: string;
  readonly packageRoot: string;
  readonly workspaceRoot: string;
  readonly deployDir: string;
}

export interface PublishExtensionPackageOptions extends DeployExtensionPackageOptions {
  readonly dryRun?: boolean;
  readonly registryClient?: ExmRegistryRemoteClient;
}

export interface PublishExtensionPackageResult extends DeployExtensionPackageResult {
  readonly dryRun: boolean;
  readonly registry: string;
  readonly indexUrl: string;
  readonly artifactUrl: string;
  readonly integrity: string;
  readonly size: number;
}

export type PublishCommandRunner = (
  file: string,
  args: readonly string[],
  options?: PublishCommandOptions,
) => Promise<void>;

export interface PublishCommandOptions {
  readonly cwd?: string;
}

export async function deployExtensionPackage(
  options: DeployExtensionPackageOptions,
): Promise<DeployExtensionPackageResult> {
  const packageName = validatePackageName(options.packageName);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspaceRoot = await findWorkspaceRoot(cwd);
  const packageRoot = await resolveWorkspacePackageRoot(workspaceRoot, packageName);
  const deployDir = path.join(packageRoot, DEPLOY_DIR_NAME);
  const runCommand = options.commandRunner ?? runCommandWithInheritedStdio;

  assertDeployDirIsSafe(packageRoot, deployDir);

  options.logger?.info('clean .deploy');
  await rm(deployDir, {
    recursive: true,
    force: true,
  });

  const deployTarget = path.relative(workspaceRoot, deployDir);
  options.logger?.info(`pnpm deploy ${packageName}`);
  await runCommand('pnpm', [
    '--config.node-linker=hoisted',
    '--filter',
    packageName,
    '--fail-if-no-match',
    'deploy',
    '--prod',
    '--legacy',
    deployTarget,
  ], {
    cwd: workspaceRoot,
  });

  options.logger?.info('validate .deploy/package.json');
  const deployedPackageJson = await validateDeployPackageJson(deployDir, packageName);
  const version = readRequiredString(deployedPackageJson, 'version', '.deploy/package.json');

  return {
    packageName,
    version,
    packageRoot,
    workspaceRoot,
    deployDir,
  };
}

export async function publishExtensionPackage(
  options: PublishExtensionPackageOptions,
): Promise<PublishExtensionPackageResult> {
  const deployment = await deployExtensionPackage(options);
  const dryRun = options.dryRun ?? false;
  const registry = await readPackageExmRegistry(deployment.packageRoot);
  const registryClient = options.registryClient ?? new NpmRegistryFetchRemoteClient();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-publish-'));

  try {
    const tarballPath = path.join(tempDir, createTarballFileName(deployment.packageName, deployment.version));
    options.logger?.info(`create ${path.basename(tarballPath)}`);
    await createDeployTarball(deployment.deployDir, tarballPath);
    const artifact = await createSha512IntegrityFromFile(tarballPath);
    const artifactPath = createExmRegistryArtifactPath(deployment.version);
    const indexUrl = createExmRegistryIndexUrl(registry, deployment.packageName);
    const artifactUrl = createExmRegistryArtifactUrl(registry, deployment.packageName, artifactPath);
    const existingIndexValue = await registryClient.readJson(indexUrl, deployment.packageRoot);
    const existingIndex = existingIndexValue === undefined
      ? createEmptyExmRegistryIndex(deployment.packageName)
      : await normalizeExmRegistryIndex(existingIndexValue, deployment.packageName, indexUrl);

    if (existingIndex.versions[deployment.version] !== undefined) {
      throw new Error(`exm registry package "${deployment.packageName}" version ${deployment.version} already exists`);
    }

    const nextIndex = addRegistryVersion(existingIndex, deployment.version, {
      type: 'tgz',
      path: artifactPath,
      integrity: artifact.integrity,
      size: artifact.size,
    });

    if (dryRun) {
      options.logger?.info(`would upload artifact ${artifactUrl}`);
      options.logger?.info(`would update index ${indexUrl}`);
      options.logger?.info(`artifact integrity ${artifact.integrity}`);
      options.logger?.info(`artifact size ${artifact.size}`);
      options.logger?.info('skip exm registry upload --dry-run');
    } else {
      options.logger?.info(`upload ${artifactUrl}`);
      await registryClient.putFile(artifactUrl, tarballPath, 'application/gzip', deployment.packageRoot);
      options.logger?.info(`update ${indexUrl}`);
      await registryClient.putJson(indexUrl, nextIndex, deployment.packageRoot);
    }

    return {
      ...deployment,
      dryRun,
      registry,
      indexUrl,
      artifactUrl,
      integrity: artifact.integrity,
      size: artifact.size,
    };
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

async function readPackageExmRegistry(packageRoot: string): Promise<string> {
  const packageJson = await readJsonObject(path.join(packageRoot, 'package.json'));

  if (!isJsonObject(packageJson.exm)) {
    throw new Error('package.json exm.registry is required to publish to exm registry');
  }

  const registry = packageJson.exm.registry;

  if (typeof registry !== 'string' || registry.length === 0) {
    throw new Error('package.json exm.registry is required to publish to exm registry');
  }

  return normalizeExmRegistryUrl(registry, 'package.json exm.registry');
}

function addRegistryVersion(index: ExmRegistryIndex, version: string, artifact: ExmRegistryIndex['versions'][string]['artifact']): ExmRegistryIndex {
  return {
    schemaVersion: 1,
    name: index.name,
    versions: Object.fromEntries(Object.entries({
      ...index.versions,
      [version]: {
        version,
        artifact,
      },
    }).sort(([left], [right]) => left.localeCompare(right))),
  };
}

async function validateDeployPackageJson(deployDir: string, packageName: string): Promise<JsonObject> {
  await assertDirectory(deployDir, 'deploy directory');
  const packageJsonPath = path.join(deployDir, 'package.json');
  const packageJson = await readJsonObject(packageJsonPath);
  const deployedName = readRequiredString(packageJson, 'name', '.deploy/package.json');

  if (deployedName !== packageName) {
    throw new Error(`.deploy/package.json name must match publish package "${packageName}": ${deployedName}`);
  }

  return packageJson;
}

async function resolveWorkspacePackageRoot(workspaceRoot: string, packageName: string): Promise<string> {
  const packageJsonPaths = await findWorkspacePackageJsonPaths(workspaceRoot);
  const matchingPackageRoots: string[] = [];

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = await readJsonObject(packageJsonPath);

    if (packageJson.name === packageName) {
      matchingPackageRoots.push(path.resolve(path.dirname(packageJsonPath)));
    }
  }

  if (matchingPackageRoots.length === 0) {
    throw new Error(`Unable to find workspace package "${packageName}" in ${workspaceRoot}`);
  }

  if (matchingPackageRoots.length > 1) {
    throw new Error(`Workspace package "${packageName}" matched multiple package roots: ${matchingPackageRoots.join(', ')}`);
  }

  return matchingPackageRoots[0]!;
}

async function findWorkspacePackageJsonPaths(workspaceRoot: string): Promise<string[]> {
  const workspacePatterns = await readWorkspacePackagePatterns(workspaceRoot);
  const includePatterns = workspacePatterns
    .filter((pattern) => !pattern.startsWith('!'))
    .map((pattern) => appendPackageJsonPattern(pattern));
  const ignorePatterns = workspacePatterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => appendPackageJsonPattern(pattern.slice(1)));

  return await glob(includePatterns, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    ignore: ignorePatterns,
  });
}

async function readWorkspacePackagePatterns(workspaceRoot: string): Promise<readonly string[]> {
  const workspaceFilePath = path.join(workspaceRoot, WORKSPACE_FILE);
  const workspaceFile = parseYaml(await readFile(workspaceFilePath, 'utf8')) as unknown;

  if (!isRecord(workspaceFile)) {
    throw new Error(`${WORKSPACE_FILE} must contain a YAML object`);
  }

  const packages = workspaceFile.packages;

  if (!Array.isArray(packages) || !packages.every((value) => typeof value === 'string')) {
    throw new Error(`${WORKSPACE_FILE} packages must be an array of strings`);
  }

  return packages;
}

async function createDeployTarball(deployDir: string, tarballPath: string): Promise<void> {
  const entries = (await readdir(deployDir)).filter((entry) => entry !== '.git');

  if (entries.length === 0) {
    throw new Error(`deploy directory must not be empty: ${deployDir}`);
  }

  await pipeline(
    packTar(deployDir, {
      entries,
      ignore: (name): boolean => path.basename(name) === '.git',
      map: (header) => ({
        ...header,
        name: path.posix.join('package', normalizeTarEntryName(header.name)),
      }),
    }),
    createGzip(),
    createWriteStream(tarballPath),
  );
}

async function findWorkspaceRoot(startPath: string): Promise<string> {
  let currentPath = startPath;

  while (true) {
    if (await pathExists(path.join(currentPath, WORKSPACE_FILE))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Unable to find ${WORKSPACE_FILE} from ${startPath}`);
    }

    currentPath = parentPath;
  }
}

function assertDeployDirIsSafe(packageRoot: string, deployDir: string): void {
  assertPathInside(packageRoot, deployDir, 'deploy directory');

  if (path.basename(deployDir) !== DEPLOY_DIR_NAME) {
    throw new Error(`deploy directory must be named ${DEPLOY_DIR_NAME}: ${deployDir}`);
  }
}

function validatePackageName(packageName: string): string {
  const trimmed = packageName.trim();

  if (trimmed.length === 0) {
    throw new Error('publish package name must not be empty');
  }

  return trimmed;
}

function readRequiredString(packageJson: JsonObject, key: string, label: string): string {
  const value = packageJson[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must include a string ${key}`);
  }

  return value;
}

function createTarballFileName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function appendPackageJsonPattern(pattern: string): string {
  const normalized = pattern.replaceAll('\\', '/').replace(/\/+$/, '');

  return normalized.endsWith('/package.json') ? normalized : `${normalized}/package.json`;
}

function normalizeTarEntryName(entryName: string): string {
  return entryName.replaceAll('\\', '/').replace(/^\/+/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runCommandWithInheritedStdio(
  file: string,
  args: readonly string[],
  options: PublishCommandOptions = {},
): Promise<void> {
  const spawnOptions = {
    cwd: options.cwd,
    stdio: 'inherit' as const,
  };
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoteWindowsCommand([file, ...args])], spawnOptions)
    : spawn(file, args, spawnOptions);

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal): void => {
      if (signal !== null) {
        reject(new Error(`Command terminated by signal ${signal}: ${file} ${args.join(' ')}`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code}: ${file} ${args.join(' ')}`));
    });
  });
}

function quoteWindowsCommand(command: readonly string[]): string {
  return command.map(quoteWindowsArgument).join(' ');
}

function quoteWindowsArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '\\"')}"`;
}
