import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import { assertDirectory, copyDirectory, pathExists } from '../fs/path.js';
import { loadNpmConfigOptions } from './npm-source.js';
import { withSupportedDependencySpecifiers } from './specifier-help.js';
import type { ExtensionRequest, ExtensionSource, MaterializedExtension, PreviousResolvedExtension, ResolvedExmRegistryExtension, ResolvedExtension, SourceContext } from './source.js';

export interface ExmRegistrySpecifier {
  readonly packageName: string;
  readonly range: string;
  readonly exactVersion?: string;
}

export interface ExmRegistryPackageRequest {
  readonly registry: string;
  readonly packageName: string;
  readonly range: string;
  readonly projectRoot: string;
}

export interface ExmRegistryClient {
  resolve(request: ExmRegistryPackageRequest): Promise<ResolvedExmRegistryExtension>;

  extract(resolved: ResolvedExmRegistryExtension, targetPath: string, projectRoot: string): Promise<void>;
}

export interface ExmRegistryRemoteClient {
  readJson(url: string, projectRoot: string): Promise<unknown | undefined>;

  downloadFile(url: string, targetPath: string, projectRoot: string): Promise<DownloadedArtifact>;

  putFile(url: string, sourcePath: string, contentType: string, projectRoot: string): Promise<void>;

  putJson(url: string, value: unknown, projectRoot: string): Promise<void>;
}

export interface DownloadedArtifact {
  readonly integrity: string;
  readonly size: number;
}

export interface ExmRegistryIndex {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly versions: Readonly<Record<string, ExmRegistryVersion>>;
}

export interface ExmRegistryVersion {
  readonly version: string;
  readonly artifact: ExmRegistryArtifact;
}

export interface ExmRegistryArtifact {
  readonly type: 'tgz';
  readonly path: string;
  readonly integrity: string;
  readonly size: number;
}

export interface ExmVersionRange {
  satisfies(version: string, range: string): Promise<boolean>;

  maxSatisfying(versions: readonly string[], range: string): Promise<string | undefined>;
}

interface SemverModule {
  valid(version: string): string | null;

  validRange(range: string): string | null;

  satisfies(version: string, range: string, options?: { readonly includePrerelease?: boolean }): boolean;

  maxSatisfying(versions: readonly string[], range: string, options?: { readonly includePrerelease?: boolean }): string | null;
}

interface NpmRegistryFetchResponse {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly body?: NodeJS.ReadableStream;
  text(): Promise<string>;
}

interface NpmRegistryFetchModule {
  (url: string, options?: Record<string, unknown>): Promise<NpmRegistryFetchResponse>;
}

export class ExmRegistrySource implements ExtensionSource {
  public readonly protocol = 'exm';

  public constructor(
    private readonly registryClient: ExmRegistryClient = new HttpExmRegistryClient(),
    private readonly versionRange: ExmVersionRange = new SemverExmVersionRange(),
  ) {}

  public canResolve(spec: string): boolean {
    return spec.startsWith('exm:');
  }

  public async resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension> {
    const exmSpecifier = await parseExmRegistrySpecifier(request.spec);
    const registry = readRequiredRegistry(context.exmRegistry, request.spec);
    const locked = await this.getUsableLockedResolution(request.previous, registry, exmSpecifier, context);
    const exm = locked ?? await this.registryClient.resolve({
      registry,
      packageName: exmSpecifier.packageName,
      range: exmSpecifier.range,
      projectRoot: context.projectRoot,
    });
    const sourcePath = path.join(context.cacheRoot, 'exm', createExmCacheKey(exm));

    return {
      id: request.id,
      spec: request.spec,
      sourceType: this.protocol,
      reference: `${exm.packageName}@${exm.version}`,
      sourcePath,
      exm,
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    const exm = resolved.exm;

    if (exm === undefined) {
      throw new Error(`Resolved extension "${resolved.id}" is missing exm registry metadata`);
    }

    if (!await pathExists(resolved.sourcePath)) {
      await mkdir(path.dirname(resolved.sourcePath), { recursive: true });
      await this.registryClient.extract(exm, resolved.sourcePath, context.projectRoot);
      await assertDirectory(resolved.sourcePath, `exm registry cache for "${resolved.id}"`);
    }

    const targetPath = path.join(context.installRoot, resolved.id);
    await copyDirectory(resolved.sourcePath, targetPath);

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'copy',
    };
  }

  private async getUsableLockedResolution(
    previous: PreviousResolvedExtension | undefined,
    registry: string,
    exmSpecifier: ExmRegistrySpecifier,
    context: SourceContext,
  ): Promise<ResolvedExmRegistryExtension | undefined> {
    const resolution = previous?.resolution;
    const previousSpecifier = previous === undefined
      ? undefined
      : await parseLockedExmRegistrySpecifier(previous.spec);

    if (
      resolution === undefined
      || previousSpecifier?.packageName !== exmSpecifier.packageName
      || resolution.version === undefined
      || resolution.integrity === undefined
    ) {
      return undefined;
    }

    if (exmSpecifier.exactVersion !== undefined) {
      if (resolution.version !== exmSpecifier.exactVersion) {
        return undefined;
      }
    } else if (context.update === true || !await this.versionRange.satisfies(resolution.version, exmSpecifier.range)) {
      return undefined;
    }

    return {
      registry,
      packageName: exmSpecifier.packageName,
      version: resolution.version,
      resolved: createExmRegistryArtifactUrl(registry, exmSpecifier.packageName, createExmRegistryArtifactPath(resolution.version)),
      integrity: resolution.integrity,
    };
  }
}

export class HttpExmRegistryClient implements ExmRegistryClient {
  public constructor(private readonly remoteClient: ExmRegistryRemoteClient = new NpmRegistryFetchRemoteClient()) {}

  public async resolve(request: ExmRegistryPackageRequest): Promise<ResolvedExmRegistryExtension> {
    const registry = normalizeExmRegistryUrl(request.registry, 'exm registry');
    const indexUrl = createExmRegistryIndexUrl(registry, request.packageName);
    const indexValue = await this.remoteClient.readJson(indexUrl, request.projectRoot);

    if (indexValue === undefined) {
      throw new Error(`exm registry package "${request.packageName}" was not found at ${indexUrl}`);
    }

    const index = await normalizeExmRegistryIndex(indexValue, request.packageName, indexUrl);
    const version = await new SemverExmVersionRange().maxSatisfying(Object.keys(index.versions), request.range);

    if (version === undefined) {
      throw new Error(`exm registry package "${request.packageName}" has no version satisfying ${request.range}`);
    }

    const entry = index.versions[version]!;

    return {
      registry,
      packageName: request.packageName,
      version,
      resolved: createExmRegistryArtifactUrl(registry, request.packageName, entry.artifact.path),
      integrity: entry.artifact.integrity,
      size: entry.artifact.size,
    };
  }

  public async extract(resolved: ResolvedExmRegistryExtension, targetPath: string, projectRoot: string): Promise<void> {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'exm-registry-'));
    const tarballPath = path.join(tempDir, 'extension.tgz');

    try {
      const downloaded = await this.remoteClient.downloadFile(resolved.resolved, tarballPath, projectRoot);

      if (downloaded.integrity !== resolved.integrity) {
        throw new Error(`exm registry artifact integrity mismatch for ${resolved.packageName}@${resolved.version}`);
      }

      await extractExmRegistryArtifact(tarballPath, targetPath);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export class NpmRegistryFetchRemoteClient implements ExmRegistryRemoteClient {
  public async readJson(url: string, projectRoot: string): Promise<unknown | undefined> {
    const fetch = await loadNpmRegistryFetch();
    const options = await loadNpmConfigOptions(projectRoot);

    try {
      const response = await fetch(url, options);
      assertOkResponse(response, url);
      return JSON.parse(await response.text()) as unknown;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  public async downloadFile(url: string, targetPath: string, projectRoot: string): Promise<DownloadedArtifact> {
    const fetch = await loadNpmRegistryFetch();
    const options = await loadNpmConfigOptions(projectRoot);
    const response = await fetch(url, options);
    assertOkResponse(response, url);

    if (response.body === undefined) {
      throw new Error(`exm registry artifact response had no body: ${url}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const hash = createHash('sha512');
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        size += chunk.byteLength;
        hash.update(chunk);
        callback(undefined, chunk);
      },
    });

    await pipeline(response.body, counter, createWriteStream(targetPath));

    return {
      integrity: `sha512-${hash.digest('base64')}`,
      size,
    };
  }

  public async putFile(url: string, sourcePath: string, contentType: string, projectRoot: string): Promise<void> {
    const fetch = await loadNpmRegistryFetch();
    const options = await loadNpmConfigOptions(projectRoot);
    const response = await fetch(url, {
      ...options,
      method: 'PUT',
      body: createReadStream(sourcePath),
      headers: {
        'content-type': contentType,
      },
    });
    assertOkResponse(response, url);
  }

  public async putJson(url: string, value: unknown, projectRoot: string): Promise<void> {
    const fetch = await loadNpmRegistryFetch();
    const options = await loadNpmConfigOptions(projectRoot);
    const response = await fetch(url, {
      ...options,
      method: 'PUT',
      body: `${JSON.stringify(value, null, 2)}\n`,
      headers: {
        'content-type': 'application/json',
      },
    });
    assertOkResponse(response, url);
  }
}

export class SemverExmVersionRange implements ExmVersionRange {
  public async satisfies(version: string, range: string): Promise<boolean> {
    const semver = await loadSemver();

    return semver.satisfies(version, range, { includePrerelease: true });
  }

  public async maxSatisfying(versions: readonly string[], range: string): Promise<string | undefined> {
    const semver = await loadSemver();

    return semver.maxSatisfying(versions, range, { includePrerelease: true }) ?? undefined;
  }
}

export async function parseExmRegistrySpecifier(spec: string): Promise<ExmRegistrySpecifier> {
  if (!spec.startsWith('exm:')) {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" must start with exm:`,
    ));
  }

  const rawPackageSpec = spec.slice('exm:'.length);
  const separatorIndex = findVersionSeparator(rawPackageSpec);

  if (separatorIndex < 0) {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" must include a package name and version range`,
    ));
  }

  const packageName = rawPackageSpec.slice(0, separatorIndex);
  const range = rawPackageSpec.slice(separatorIndex + 1);
  validateExmPackageName(spec, packageName);
  await validateExmVersionRange(spec, range);

  return {
    packageName,
    range,
    ...optionalStringField('exactVersion', await readExactVersion(range)),
  };
}

export function normalizeExmRegistryUrl(value: string, label: string): string {
  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an http or https URL`);
  }

  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export function createExmRegistryIndexUrl(registry: string, packageName: string): string {
  return new URL(`${encodePackagePath(packageName)}/index.json`, registry).href;
}

export function createExmRegistryArtifactUrl(registry: string, packageName: string, artifactPath: string): string {
  return new URL(`${encodePackagePath(packageName)}/${artifactPath}`, registry).href;
}

export function createExmRegistryArtifactPath(version: string): string {
  return `${encodeURIComponent(version)}/extension.tgz`;
}

export function createEmptyExmRegistryIndex(packageName: string): ExmRegistryIndex {
  return {
    schemaVersion: 1,
    name: packageName,
    versions: {},
  };
}

export async function normalizeExmRegistryIndex(value: unknown, packageName: string, label: string): Promise<ExmRegistryIndex> {
  if (!isRecord(value)) {
    throw new Error(`exm registry index ${label} must contain an object`);
  }

  if (value.schemaVersion !== 1) {
    throw new Error(`exm registry index ${label} schemaVersion must be 1`);
  }

  if (value.name !== packageName) {
    throw new Error(`exm registry index ${label} name must be ${packageName}`);
  }

  if (!isRecord(value.versions)) {
    throw new Error(`exm registry index ${label} versions must be an object`);
  }

  const versions: Record<string, ExmRegistryVersion> = {};

  for (const [version, entry] of Object.entries(value.versions)) {
    versions[version] = await normalizeExmRegistryVersion(entry, version, label);
  }

  return {
    schemaVersion: 1,
    name: packageName,
    versions,
  };
}

export function createSha512IntegrityFromBuffer(buffer: Buffer): string {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

export async function createSha512IntegrityFromFile(filePath: string): Promise<DownloadedArtifact> {
  const hash = createHash('sha512');
  let size = 0;
  const counter = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      size += chunk.byteLength;
      hash.update(chunk);
      callback();
    },
  });

  await pipeline(createReadStream(filePath), counter);

  return {
    integrity: `sha512-${hash.digest('base64')}`,
    size,
  };
}

async function normalizeExmRegistryVersion(value: unknown, version: string, label: string): Promise<ExmRegistryVersion> {
  const semver = await loadSemver();

  if (semver.valid(version) === null) {
    throw new Error(`exm registry index ${label} version "${version}" must be valid semver`);
  }

  if (!isRecord(value)) {
    throw new Error(`exm registry index ${label} version "${version}" must be an object`);
  }

  if (value.version !== version) {
    throw new Error(`exm registry index ${label} version "${version}" must include matching version`);
  }

  return {
    version,
    artifact: normalizeExmRegistryArtifact(value.artifact, label, version),
  };
}

function normalizeExmRegistryArtifact(value: unknown, label: string, version: string): ExmRegistryArtifact {
  if (!isRecord(value)) {
    throw new Error(`exm registry index ${label} version "${version}" artifact must be an object`);
  }

  if (value.type !== 'tgz') {
    throw new Error(`exm registry index ${label} version "${version}" artifact type must be tgz`);
  }

  const artifactPath = readRequiredString(value.path, `exm registry index ${label} version "${version}" artifact path`);
  validateArtifactPath(artifactPath, label, version);

  if (artifactPath !== createExmRegistryArtifactPath(version)) {
    throw new Error(`exm registry index ${label} version "${version}" artifact path must be ${createExmRegistryArtifactPath(version)}`);
  }
  const integrity = readRequiredString(value.integrity, `exm registry index ${label} version "${version}" artifact integrity`);
  validateSha512Integrity(integrity, `exm registry index ${label} version "${version}" artifact integrity`);

  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size <= 0) {
    throw new Error(`exm registry index ${label} version "${version}" artifact size must be a positive integer`);
  }

  return {
    type: 'tgz',
    path: artifactPath,
    integrity,
    size: value.size,
  };
}

async function extractExmRegistryArtifact(tarballPath: string, targetPath: string): Promise<void> {
  let hasPackageContent = false;
  await rm(targetPath, { recursive: true, force: true });
  await mkdir(targetPath, { recursive: true });
  await extractTar({
    file: tarballPath,
    cwd: targetPath,
    strip: 1,
    filter: (entryPath: string): boolean => {
      const normalizedPath = entryPath.replaceAll('\\', '/');

      if (normalizedPath.startsWith('package/')) {
        hasPackageContent = true;
        return true;
      }

      return normalizedPath === 'package';
    },
  });

  if (!hasPackageContent) {
    throw new Error('exm registry artifact must contain a package/ root');
  }
}

async function parseLockedExmRegistrySpecifier(spec: string): Promise<ExmRegistrySpecifier | undefined> {
  try {
    return await parseExmRegistrySpecifier(spec);
  } catch {
    return undefined;
  }
}

function readRequiredRegistry(value: string | undefined, spec: string): string {
  if (value === undefined) {
    throw new Error(`exm registry dependency source "${spec}" requires package.json exm.registry`);
  }

  return normalizeExmRegistryUrl(value, 'package.json exm.registry');
}

function createExmCacheKey(resolved: ResolvedExmRegistryExtension): string {
  return createHash('sha256')
    .update(resolved.registry)
    .update('\0')
    .update(resolved.packageName)
    .update('\0')
    .update(resolved.version)
    .update('\0')
    .update(resolved.resolved)
    .update('\0')
    .update(resolved.integrity)
    .digest('hex')
    .slice(0, 16);
}

function findVersionSeparator(rawPackageSpec: string): number {
  if (rawPackageSpec.startsWith('@')) {
    const slashIndex = rawPackageSpec.indexOf('/');

    if (slashIndex < 0) {
      return -1;
    }

    return rawPackageSpec.indexOf('@', slashIndex + 1);
  }

  return rawPackageSpec.lastIndexOf('@');
}

function validateExmPackageName(spec: string, packageName: string): void {
  const nameSegment = '[a-z0-9][a-z0-9._~-]*';
  const packagePattern = new RegExp(`^(?:${nameSegment}|@${nameSegment}/${nameSegment})$`);

  if (!packagePattern.test(packageName)) {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" package name is invalid`,
    ));
  }
}

async function validateExmVersionRange(spec: string, range: string): Promise<void> {
  if (range.length === 0 || range === '*') {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" must include an explicit version range`,
    ));
  }

  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(range)) {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" must not use a dist-tag`,
    ));
  }

  const semver = await loadSemver();

  if (semver.validRange(range) === null) {
    throw new Error(withSupportedDependencySpecifiers(
      `exm registry dependency source "${spec}" must include a semver version or range`,
    ));
  }
}

async function readExactVersion(range: string): Promise<string | undefined> {
  const semver = await loadSemver();

  return semver.valid(range) ?? undefined;
}

function validateArtifactPath(value: string, label: string, version: string): void {
  const parts = value.split('/');

  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error(`exm registry index ${label} version "${version}" artifact path must be a relative URL path`);
  }
}

function validateSha512Integrity(value: string, label: string): void {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be a sha512 integrity string`);
  }
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function encodePackagePath(packageName: string): string {
  return packageName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function assertOkResponse(response: NpmRegistryFetchResponse, url: string): void {
  if (response.ok === false) {
    throw new Error(`exm registry request failed for ${url}: ${response.status ?? 'unknown'} ${response.statusText ?? ''}`.trim());
  }
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.statusCode === 404 || error.code === 'E404');
}

async function loadNpmRegistryFetch(): Promise<NpmRegistryFetchModule> {
  const registryFetch = await import('npm-registry-fetch') as { readonly default?: NpmRegistryFetchModule } & NpmRegistryFetchModule;

  return registryFetch.default ?? registryFetch;
}

async function loadSemver(): Promise<SemverModule> {
  const semver = await import('semver') as { readonly default?: SemverModule } & SemverModule;

  return semver.default ?? semver;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
