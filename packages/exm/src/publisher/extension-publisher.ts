import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { createSha512IntegrityFromFile, normalizeExmRegistryUrl } from '../sources/exm-registry-source.js';
import { loadNpmConfigOptions } from '../sources/npm-source.js';
import type { JsonObject } from '../config/package-json.js';

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
  readonly sourcePackageName: string;
  readonly version: string;
  readonly packageRoot: string;
  readonly workspaceRoot: string;
  readonly deployDir: string;
}

export interface PublishExtensionPackageOptions extends DeployExtensionPackageOptions {
  readonly dryRun?: boolean;
  readonly registry?: string;
  readonly registryClient?: ExmRegistryPublishClient;
}

export interface PublishExtensionPackageResult extends DeployExtensionPackageResult {
  readonly dryRun: boolean;
  readonly registry: string;
  readonly registryPackageName: string;
  readonly extensionId?: string;
  readonly metadataUrl: string;
  readonly artifactUrl: string;
  readonly integrity: string;
  readonly size: number;
}

export interface ExmRegistryPublishRequest {
  readonly registry: string;
  readonly packageName: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly integrity: string;
  readonly size: number;
  readonly projectRoot: string;
}

export interface ExmRegistryPublishPlanRequest {
  readonly registry: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly size: number;
  readonly projectRoot: string;
}

export interface ExmRegistryPublishResult {
  readonly packageName: string;
  readonly version: string;
  readonly metadataUrl: string;
  readonly artifactUrl: string;
  readonly integrity: string;
  readonly size: number;
}

export interface ExmRegistryPublishClient {
  plan(request: ExmRegistryPublishPlanRequest): Promise<ExmRegistryPublishResult>;

  publish(request: ExmRegistryPublishRequest): Promise<ExmRegistryPublishResult>;
}

export type PublishCommandRunner = (
  file: string,
  args: readonly string[],
  options?: PublishCommandOptions,
) => Promise<void>;

export interface PublishCommandOptions {
  readonly cwd?: string;
}

interface NpmRegistryFetchResponse {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
  text(): Promise<string>;
}

interface NpmRegistryFetchModule {
  (url: string, options?: Record<string, unknown>): Promise<NpmRegistryFetchResponse>;
}

interface PublishIdentity {
  readonly registryPackageName: string;
  readonly extensionId?: string;
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
    sourcePackageName: packageName,
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
  const packageExm = await readPackageExmConfig(deployment.packageRoot);
  const registry = resolvePublishRegistry(packageExm, options.registry);
  const identity = readPublishIdentity(packageExm, deployment.packageName);
  const registryClient = options.registryClient ?? new HttpExmRegistryPublishClient();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-publish-'));

  try {
    if (identity.registryPackageName !== deployment.packageName || identity.extensionId !== undefined) {
      options.logger?.info(formatPublishIdentity(deployment.packageName, identity));
    }

    if (identity.extensionId !== undefined) {
      await patchDeployPackageName(deployment.deployDir, deployment.packageName, identity.extensionId);
    }

    const tarballPath = path.join(tempDir, createTarballFileName(identity.registryPackageName, deployment.version));
    options.logger?.info(`create ${path.basename(tarballPath)}`);
    await createDeployTarball(deployment.deployDir, tarballPath);
    const artifact = await createSha512IntegrityFromFile(tarballPath);
    const publishRequest = {
      registry,
      packageName: identity.registryPackageName,
      version: deployment.version,
      tarballPath,
      integrity: artifact.integrity,
      size: artifact.size,
      projectRoot: deployment.packageRoot,
    };
    const published = dryRun
      ? await registryClient.plan(publishRequest)
      : await registryClient.publish(publishRequest);

    if (dryRun) {
      options.logger?.info(`would publish artifact ${published.artifactUrl}`);
      options.logger?.info(`would update metadata ${published.metadataUrl}`);
      options.logger?.info(`artifact integrity ${artifact.integrity}`);
      options.logger?.info(`artifact size ${artifact.size}`);
      options.logger?.info('skip exm registry publish --dry-run');
    } else {
      options.logger?.info(`published artifact ${published.artifactUrl}`);
      options.logger?.info(`updated metadata ${published.metadataUrl}`);
    }

    return {
      ...deployment,
      dryRun,
      registry,
      registryPackageName: identity.registryPackageName,
      ...optionalStringField('extensionId', identity.extensionId),
      metadataUrl: published.metadataUrl,
      artifactUrl: published.artifactUrl,
      integrity: published.integrity,
      size: published.size,
    };
  } finally {
    await rm(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

export class HttpExmRegistryPublishClient implements ExmRegistryPublishClient {
  public async plan(request: ExmRegistryPublishPlanRequest): Promise<ExmRegistryPublishResult> {
    const response = await this.requestJson(createPublishPlanUrl(request.registry), request.projectRoot, {
      method: 'POST',
      body: `${JSON.stringify({
        name: request.packageName,
        version: request.version,
        integrity: request.integrity,
        size: request.size,
      })}\n`,
      headers: {
        'content-type': 'application/json',
      },
    });

    return normalizePublishResult(response, request);
  }

  public async publish(request: ExmRegistryPublishRequest): Promise<ExmRegistryPublishResult> {
    const response = await this.requestJson(createPublishUrl(request.registry, request.packageName, request.version), request.projectRoot, {
      method: 'PUT',
      body: createReadStream(request.tarballPath),
      headers: {
        'content-type': 'application/gzip',
        'x-exm-integrity': request.integrity,
        'x-exm-size': String(request.size),
      },
    });

    return normalizePublishResult(response, request);
  }

  private async requestJson(url: string, projectRoot: string, options: Record<string, unknown>): Promise<unknown> {
    const fetch = await loadNpmRegistryFetch();
    const config = await loadNpmConfigOptions(projectRoot);
    const response = await fetch(url, {
      ...config,
      ...options,
    });
    const text = await response.text();

    if (response.ok === false) {
      throw new Error(`exm registry request failed for ${url}: ${response.status ?? 'unknown'} ${response.statusText ?? ''} ${text}`.trim());
    }

    return JSON.parse(text) as unknown;
  }
}

function createPublishPlanUrl(registry: string): string {
  return new URL('-/exm/v1/publish/plan', registry).href;
}

function createPublishUrl(registry: string, packageName: string, version: string): string {
  const url = new URL('-/exm/v1/publish', registry);
  url.searchParams.set('name', packageName);
  url.searchParams.set('version', version);

  return url.href;
}

function normalizePublishResult(value: unknown, request: ExmRegistryPublishPlanRequest): ExmRegistryPublishResult {
  if (!isRecord(value)) {
    throw new Error('exm registry publish response must be an object');
  }

  const packageName = readResultString(value.packageName, 'packageName');
  const version = readResultString(value.version, 'version');

  if (packageName !== request.packageName || version !== request.version) {
    throw new Error(`exm registry publish response returned unexpected package ${packageName}@${version}`);
  }

  return {
    packageName,
    version,
    metadataUrl: readResultString(value.metadataUrl, 'metadataUrl'),
    artifactUrl: readResultString(value.artifactUrl, 'artifactUrl'),
    integrity: readResultString(value.integrity, 'integrity'),
    size: readResultPositiveInteger(value.size, 'size'),
  };
}

async function readPackageExmConfig(packageRoot: string): Promise<Record<string, unknown> | undefined> {
  const packageJson = await readJsonObject(path.join(packageRoot, 'package.json'));
  const exm = packageJson.exm;

  if (exm === undefined) {
    return undefined;
  }

  if (!isJsonObject(exm)) {
    throw new Error('package.json exm field must be an object');
  }

  return exm;
}

function resolvePublishRegistry(packageExm: Record<string, unknown> | undefined, registry: string | undefined): string {
  if (registry !== undefined) {
    const trimmed = registry.trim();

    if (trimmed.length === 0) {
      throw new Error('publish --registry must be a non-empty URL');
    }

    return normalizeExmRegistryUrl(trimmed, 'publish --registry');
  }

  const packageRegistry = packageExm?.registry;

  if (typeof packageRegistry !== 'string' || packageRegistry.length === 0) {
    throw new Error('package.json exm.registry is required to publish to exm registry');
  }

  return normalizeExmRegistryUrl(packageRegistry, 'package.json exm.registry');
}

function readPublishIdentity(packageExm: Record<string, unknown> | undefined, sourcePackageName: string): PublishIdentity {
  const registryPackageName = packageExm?.registryPackageName;
  const extensionId = packageExm?.extensionId;

  return {
    registryPackageName: registryPackageName === undefined
      ? validateRegistryPackageName(sourcePackageName, 'package.json name')
      : validateRegistryPackageName(readRequiredStringValue(registryPackageName, 'package.json exm.registryPackageName'), 'package.json exm.registryPackageName'),
    ...optionalStringField('extensionId', extensionId === undefined
      ? undefined
      : validatePublishExtensionId(readRequiredStringValue(extensionId, 'package.json exm.extensionId'), 'package.json exm.extensionId')),
  };
}

async function patchDeployPackageName(deployDir: string, sourcePackageName: string, extensionId: string): Promise<void> {
  const packageJsonPath = path.join(deployDir, 'package.json');
  const packageJson = await readJsonObject(packageJsonPath);
  const deployedName = readRequiredString(packageJson, 'name', '.deploy/package.json');

  if (deployedName !== sourcePackageName) {
    throw new Error(`.deploy/package.json name must match publish package "${sourcePackageName}": ${deployedName}`);
  }

  await writeFile(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    name: extensionId,
  }, null, 2)}\n`);
}

function formatPublishIdentity(sourcePackageName: string, identity: PublishIdentity): string {
  return [
    `publish identity source=${sourcePackageName}`,
    `registry=${identity.registryPackageName}`,
    identity.extensionId === undefined ? undefined : `extension=${identity.extensionId}`,
  ].filter((part) => part !== undefined).join(' ');
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

function validateRegistryPackageName(packageName: string, label: string): string {
  const nameSegment = '[a-z0-9][a-z0-9._~-]*';
  const packagePattern = new RegExp(`^(?:${nameSegment}|@${nameSegment}/${nameSegment})$`);

  if (!packagePattern.test(packageName)) {
    throw new Error(`${label} must be a valid npm package name`);
  }

  return packageName;
}

function validatePublishExtensionId(extensionId: string, label: string): string {
  if (extensionId.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (extensionId === '.' || extensionId === '..') {
    throw new Error(`Invalid ${label}: ${extensionId}`);
  }

  if (extensionId.includes('/') || extensionId.includes('\\') || extensionId.includes(':')) {
    throw new Error(`${label} must be a single path segment`);
  }

  return extensionId;
}

function readRequiredString(packageJson: JsonObject, key: string, label: string): string {
  const value = packageJson[key];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must include a string ${key}`);
  }

  return value;
}

function readRequiredStringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function readResultString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`exm registry publish response ${label} must be a non-empty string`);
  }

  return value;
}

function readResultPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`exm registry publish response ${label} must be a positive integer`);
  }

  return value;
}

function createTarballFileName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
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

async function loadNpmRegistryFetch(): Promise<NpmRegistryFetchModule> {
  const registryFetch = await import('npm-registry-fetch') as { readonly default?: NpmRegistryFetchModule } & NpmRegistryFetchModule;

  return registryFetch.default ?? registryFetch;
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
