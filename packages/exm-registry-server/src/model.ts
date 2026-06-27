import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export interface ExmArtifactMetadata {
  readonly type: 'tgz';
  readonly path: string;
  readonly integrity: string;
  readonly size: number;
}

export interface ExmPackageVersionDocument {
  readonly name: string;
  readonly version: string;
  readonly dist: {
    readonly tarball: string;
    readonly integrity: string;
  };
  readonly exm: {
    readonly artifact: ExmArtifactMetadata;
  };
}

export interface ExmPackageDocument {
  readonly 'name': string;
  readonly 'versions': Readonly<Record<string, ExmPackageVersionDocument>>;
  readonly 'dist-tags': Readonly<Record<string, string>>;
  readonly 'exm': {
    readonly schemaVersion: 1;
  };
}

export interface ExmSearchIndex {
  readonly schemaVersion: 1;
  readonly packages: Readonly<Record<string, ExmSearchPackage>>;
}

export interface ExmSearchPackage {
  readonly name: string;
  readonly version: string;
}

export interface ExmPublishPlan {
  readonly packageName: string;
  readonly version: string;
  readonly metadataUrl: string;
  readonly artifactUrl: string;
  readonly integrity: string;
  readonly size: number;
}

export interface SemverModule {
  valid(version: string): string | null;
  rcompare(left: string, right: string): number;
}

export function normalizeRegistryUrl(value: string, label: string): string {
  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an http or https URL`);
  }

  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

export function encodePackagePath(packageName: string): string {
  return packageName.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export function decodePackagePath(packagePath: string): string {
  return decodeURIComponent(packagePath.replace(/^\/+/, '').replace(/\/+$/, ''));
}

export function validatePackageName(packageName: string): void {
  const nameSegment = '[a-z0-9][a-z0-9._~-]*';
  const packagePattern = new RegExp(`^(?:${nameSegment}|@${nameSegment}/${nameSegment})$`);

  if (!packagePattern.test(packageName)) {
    throw new Error(`package name is invalid: ${packageName}`);
  }
}

export async function validateVersion(version: string): Promise<void> {
  const semver = await loadSemver();

  if (semver.valid(version) === null) {
    throw new Error(`version must be valid semver: ${version}`);
  }
}

export function createArtifactPath(version: string): string {
  return `${encodeURIComponent(version)}/extension.tgz`;
}

export function createArtifactStoragePath(packageName: string, version: string): string {
  return `${encodePackagePath(packageName)}/${createArtifactPath(version)}`;
}

export function createPackageStoragePath(packageName: string): string {
  return `${encodePackagePath(packageName)}/index.json`;
}

export function createPackageMetadataUrl(publicUrl: string, packageName: string): string {
  return new URL(encodePackagePath(packageName), normalizeRegistryUrl(publicUrl, 'public registry URL')).href;
}

export function createArtifactUrl(publicUrl: string, packageName: string, version: string): string {
  return new URL(`${encodePackagePath(packageName)}/${createArtifactPath(version)}`, normalizeRegistryUrl(publicUrl, 'public registry URL')).href;
}

export function createEmptyPackageDocument(packageName: string): ExmPackageDocument {
  return {
    'name': packageName,
    'versions': {},
    'dist-tags': {},
    'exm': {
      schemaVersion: 1,
    },
  };
}

export async function addPackageVersion(
  document: ExmPackageDocument,
  version: string,
  artifact: ExmArtifactMetadata,
  publicUrl: string,
): Promise<ExmPackageDocument> {
  const versions = {
    ...document.versions,
    [version]: createPackageVersionDocument(document.name, version, artifact, publicUrl),
  };
  const latest = await findLatestVersion(Object.keys(versions));

  return {
    'name': document.name,
    'versions': sortObjectByKey(versions),
    'dist-tags': latest === undefined ? {} : { latest },
    'exm': {
      schemaVersion: 1,
    },
  };
}

export function createPackageVersionDocument(
  packageName: string,
  version: string,
  artifact: ExmArtifactMetadata,
  publicUrl: string,
): ExmPackageVersionDocument {
  return {
    name: packageName,
    version,
    dist: {
      tarball: createArtifactUrl(publicUrl, packageName, version),
      integrity: artifact.integrity,
    },
    exm: {
      artifact,
    },
  };
}

export async function normalizePackageDocument(value: unknown, packageName: string, publicUrl: string, label: string): Promise<ExmPackageDocument> {
  if (!isRecord(value)) {
    throw new Error(`${label} must contain an object`);
  }

  if (value.schemaVersion === 1 && value.name === packageName && isRecord(value.versions)) {
    return await normalizeLegacyIndex(value, packageName, publicUrl, label);
  }

  if (value.name !== packageName) {
    throw new Error(`${label} name must be ${packageName}`);
  }

  if (!isRecord(value.versions)) {
    throw new Error(`${label} versions must be an object`);
  }

  const versions: Record<string, ExmPackageVersionDocument> = {};

  for (const [version, entry] of Object.entries(value.versions)) {
    versions[version] = normalizePackageVersion(entry, packageName, version, label);
  }

  const latest = await findLatestVersion(Object.keys(versions));

  return {
    'name': packageName,
    'versions': sortObjectByKey(versions),
    'dist-tags': latest === undefined ? {} : { latest },
    'exm': {
      schemaVersion: 1,
    },
  };
}

export function normalizeSearchIndex(value: unknown): ExmSearchIndex {
  if (value === undefined) {
    return createEmptySearchIndex();
  }

  if (!isRecord(value)) {
    throw new Error('exm search index must contain an object');
  }

  if (value.schemaVersion !== 1) {
    throw new Error('exm search index schemaVersion must be 1');
  }

  if (!isRecord(value.packages)) {
    throw new Error('exm search index packages must be an object');
  }

  const packages: Record<string, ExmSearchPackage> = {};

  for (const [name, entry] of Object.entries(value.packages)) {
    if (!isRecord(entry) || entry.name !== name || typeof entry.version !== 'string') {
      throw new Error(`exm search index package ${name} is invalid`);
    }

    packages[name] = {
      name,
      version: entry.version,
    };
  }

  return {
    schemaVersion: 1,
    packages: sortObjectByKey(packages),
  };
}

export function createEmptySearchIndex(): ExmSearchIndex {
  return {
    schemaVersion: 1,
    packages: {},
  };
}

export function updateSearchIndex(index: ExmSearchIndex, document: ExmPackageDocument): ExmSearchIndex {
  const latest = document['dist-tags'].latest ?? Object.keys(document.versions).at(-1);

  if (latest === undefined) {
    return index;
  }

  return {
    schemaVersion: 1,
    packages: sortObjectByKey({
      ...index.packages,
      [document.name]: {
        name: document.name,
        version: latest,
      },
    }),
  };
}

export function createSha512Integrity(buffer: Buffer): string {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

function normalizePackageVersion(value: unknown, packageName: string, version: string, label: string): ExmPackageVersionDocument {
  if (!isRecord(value)) {
    throw new Error(`${label} version ${version} must be an object`);
  }

  if (value.name !== packageName) {
    throw new Error(`${label} version ${version} name must be ${packageName}`);
  }

  if (value.version !== version) {
    throw new Error(`${label} version ${version} must include matching version`);
  }

  if (!isRecord(value.dist)) {
    throw new Error(`${label} version ${version} dist must be an object`);
  }

  const tarball = readRequiredString(value.dist.tarball, `${label} version ${version} dist.tarball`);
  const integrity = readRequiredString(value.dist.integrity, `${label} version ${version} dist.integrity`);
  const artifact = normalizeArtifact(isRecord(value.exm) ? value.exm.artifact : undefined, version, label);

  return {
    name: packageName,
    version,
    dist: {
      tarball,
      integrity,
    },
    exm: {
      artifact,
    },
  };
}

async function normalizeLegacyIndex(value: Record<string, unknown>, packageName: string, publicUrl: string, label: string): Promise<ExmPackageDocument> {
  const versionsValue = value.versions;

  if (!isRecord(versionsValue)) {
    throw new Error(`${label} versions must be an object`);
  }

  let document = createEmptyPackageDocument(packageName);

  for (const [version, entry] of Object.entries(versionsValue)) {
    if (!isRecord(entry) || entry.version !== version) {
      throw new Error(`${label} legacy version ${version} is invalid`);
    }

    document = await addPackageVersion(document, version, normalizeArtifact(entry.artifact, version, label), publicUrl);
  }

  return document;
}

function normalizeArtifact(value: unknown, version: string, label: string): ExmArtifactMetadata {
  if (!isRecord(value)) {
    throw new Error(`${label} version ${version} artifact must be an object`);
  }

  if (value.type !== 'tgz') {
    throw new Error(`${label} version ${version} artifact type must be tgz`);
  }

  const artifactPath = readRequiredString(value.path, `${label} version ${version} artifact.path`);
  const integrity = readRequiredString(value.integrity, `${label} version ${version} artifact.integrity`);

  if (artifactPath !== createArtifactPath(version)) {
    throw new Error(`${label} version ${version} artifact.path must be ${createArtifactPath(version)}`);
  }

  if (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size <= 0) {
    throw new Error(`${label} version ${version} artifact.size must be a positive integer`);
  }

  return {
    type: 'tgz',
    path: artifactPath,
    integrity,
    size: value.size,
  };
}

async function findLatestVersion(versions: readonly string[]): Promise<string | undefined> {
  if (versions.length === 0) {
    return undefined;
  }

  const semver = await loadSemver();

  return [...versions].sort(semver.rcompare)[0];
}

async function loadSemver(): Promise<SemverModule> {
  const semver = await import('semver') as { readonly default?: SemverModule } & SemverModule;

  return semver.default ?? semver;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function sortObjectByKey<Value>(value: Readonly<Record<string, Value>>): Record<string, Value> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) as Record<string, Value>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
