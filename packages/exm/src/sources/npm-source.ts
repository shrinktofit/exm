import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { assertDirectory, copyDirectory, pathExists } from '../fs/path.js';
import { withSupportedDependencySpecifiers } from './specifier-help.js';
import type { ExtensionRequest, ExtensionSource, MaterializedExtension, PreviousResolvedExtension, ResolvedExtension, ResolvedNpmExtension, SourceContext } from './source.js';

export interface NpmSpecifier {
  readonly packageName: string;
  readonly range: string;
  readonly exactVersion?: string;
}

export interface NpmPackageRequest {
  readonly packageName: string;
  readonly range: string;
  readonly projectRoot: string;
}

export interface NpmPackageClient {
  resolve(request: NpmPackageRequest): Promise<ResolvedNpmExtension>;

  extract(resolved: ResolvedNpmExtension, targetPath: string, projectRoot: string): Promise<void>;
}

export interface NpmVersionRange {
  satisfies(version: string, range: string): Promise<boolean>;
}

interface PacoteManifest {
  readonly name?: string;
  readonly version?: string;
  readonly _resolved?: string;
  readonly _integrity?: string;
  readonly dist?: {
    readonly tarball?: string;
    readonly integrity?: string;
  };
}

interface PacoteModule {
  manifest(spec: string, options: Record<string, unknown>): Promise<PacoteManifest>;

  extract(spec: string, targetPath: string, options: Record<string, unknown>): Promise<void>;
}

interface SemverModule {
  valid(version: string): string | null;

  validRange(range: string): string | null;

  satisfies(version: string, range: string, options?: { readonly includePrerelease?: boolean }): boolean;
}

export class NpmExtensionSource implements ExtensionSource {
  public readonly protocol = 'npm';

  public constructor(
    private readonly packageClient: NpmPackageClient = new PacoteNpmPackageClient(),
    private readonly versionRange: NpmVersionRange = new SemverNpmVersionRange(),
  ) {}

  public canResolve(spec: string): boolean {
    return spec.startsWith('npm:');
  }

  public async resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension> {
    const npmSpecifier = await parseNpmSpecifier(request.spec);
    const locked = await this.getUsableLockedResolution(request.previous, npmSpecifier, context);
    const npm = locked ?? await this.packageClient.resolve({
      packageName: npmSpecifier.packageName,
      range: npmSpecifier.range,
      projectRoot: context.projectRoot,
    });
    const sourcePath = path.join(context.cacheRoot, 'npm', createNpmCacheKey(npm));

    return {
      id: request.id,
      spec: request.spec,
      sourceType: this.protocol,
      reference: `${npm.packageName}@${npm.version}`,
      sourcePath,
      npm,
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    const npm = resolved.npm;

    if (npm === undefined) {
      throw new Error(`Resolved extension "${resolved.id}" is missing npm metadata`);
    }

    if (!await pathExists(resolved.sourcePath)) {
      await mkdir(path.dirname(resolved.sourcePath), { recursive: true });
      await this.packageClient.extract(npm, resolved.sourcePath, context.projectRoot);
      await assertDirectory(resolved.sourcePath, `npm package cache for "${resolved.id}"`);
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
    npmSpecifier: NpmSpecifier,
    context: SourceContext,
  ): Promise<ResolvedNpmExtension | undefined> {
    if (
      previous?.source !== 'npm'
      || previous.packageName !== npmSpecifier.packageName
      || previous.version === undefined
      || previous.resolved === undefined
    ) {
      return undefined;
    }

    if (npmSpecifier.exactVersion !== undefined) {
      if (previous.version !== npmSpecifier.exactVersion) {
        return undefined;
      }
    } else if (context.update === true || !await this.versionRange.satisfies(previous.version, npmSpecifier.range)) {
      return undefined;
    }

    return {
      packageName: previous.packageName,
      version: previous.version,
      resolved: previous.resolved,
      integrity: previous.integrity,
    };
  }
}

export class PacoteNpmPackageClient implements NpmPackageClient {
  public async resolve(request: NpmPackageRequest): Promise<ResolvedNpmExtension> {
    const pacote = await loadPacote();
    const options = await loadNpmConfigOptions(request.projectRoot);
    const manifest = await pacote.manifest(`${request.packageName}@${request.range}`, options);
    const packageName = readManifestString(manifest.name, 'name');

    if (packageName !== request.packageName) {
      throw new Error(`npm package "${request.packageName}" resolved to unexpected package "${packageName}"`);
    }

    return {
      packageName,
      version: readManifestString(manifest.version, 'version'),
      resolved: readManifestString(manifest._resolved ?? manifest.dist?.tarball, 'resolved tarball'),
      ...optionalStringField('integrity', readOptionalManifestString(manifest._integrity ?? manifest.dist?.integrity, 'integrity')),
    };
  }

  public async extract(resolved: ResolvedNpmExtension, targetPath: string, projectRoot: string): Promise<void> {
    const pacote = await loadPacote();
    const options = await loadNpmConfigOptions(projectRoot);
    await pacote.extract(resolved.resolved, targetPath, {
      ...options,
      ...optionalStringField('integrity', resolved.integrity),
    });
  }
}

export class SemverNpmVersionRange implements NpmVersionRange {
  public async satisfies(version: string, range: string): Promise<boolean> {
    const semver = await loadSemver();

    return semver.satisfies(version, range, { includePrerelease: true });
  }
}

export async function parseNpmSpecifier(spec: string): Promise<NpmSpecifier> {
  if (!spec.startsWith('npm:')) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must start with npm:`,
    ));
  }

  const rawPackageSpec = spec.slice('npm:'.length);
  const separatorIndex = findVersionSeparator(rawPackageSpec);

  if (separatorIndex < 0) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must include a package name and version range`,
    ));
  }

  const packageName = rawPackageSpec.slice(0, separatorIndex);
  const range = rawPackageSpec.slice(separatorIndex + 1);
  validateNpmPackageName(spec, packageName);
  await validateNpmVersionRange(spec, range);

  return {
    packageName,
    range,
    ...optionalStringField('exactVersion', await readExactVersion(range)),
  };
}

function createNpmCacheKey(resolved: ResolvedNpmExtension): string {
  return createHash('sha256')
    .update(resolved.packageName)
    .update('\0')
    .update(resolved.version)
    .update('\0')
    .update(resolved.resolved)
    .update('\0')
    .update(resolved.integrity ?? '')
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

function validateNpmPackageName(spec: string, packageName: string): void {
  const nameSegment = '[a-z0-9][a-z0-9._~-]*';
  const packagePattern = new RegExp(`^(?:${nameSegment}|@${nameSegment}/${nameSegment})$`);

  if (!packagePattern.test(packageName)) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" package name is invalid`,
    ));
  }
}

async function validateNpmVersionRange(spec: string, range: string): Promise<void> {
  if (range.length === 0 || range === '*') {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must include an explicit version range`,
    ));
  }

  if (range.includes('npm:')) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must not use npm aliases`,
    ));
  }

  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(range)) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must not use a dist-tag`,
    ));
  }

  const semver = await loadSemver();

  if (semver.validRange(range) === null) {
    throw new Error(withSupportedDependencySpecifiers(
      `npm dependency source "${spec}" must include a semver version or range`,
    ));
  }
}

async function readExactVersion(range: string): Promise<string | undefined> {
  const semver = await loadSemver();

  return semver.valid(range) ?? undefined;
}

async function loadPacote(): Promise<PacoteModule> {
  const pacote = await import('pacote') as { readonly default?: PacoteModule } & PacoteModule;

  return pacote.default ?? pacote;
}

async function loadSemver(): Promise<SemverModule> {
  const semver = await import('semver') as { readonly default?: SemverModule } & SemverModule;

  return semver.default ?? semver;
}

export async function loadNpmConfigOptions(projectRoot: string): Promise<Record<string, unknown>> {
  const [{ default: Config }, definitionsModule] = await Promise.all([
    import('@npmcli/config') as Promise<{ readonly default: NpmConfigConstructor }>,
    import('@npmcli/config/lib/definitions/index.js') as Promise<{ readonly default: unknown }>,
  ]);
  const definitions = readNpmConfigDefinitions(definitionsModule.default);
  const config = new Config({
    definitions: definitions.definitions,
    shorthands: definitions.shorthands,
    flatten: definitions.flatten,
    nerfDarts: definitions.nerfDarts,
    npmPath: projectRoot,
    cwd: projectRoot,
    env: process.env,
    argv: [],
    warn: false,
  });
  await config.load();

  return config.flat;
}

interface NpmConfigConstructor {
  new(options: {
    readonly definitions: Record<string, unknown>;
    readonly shorthands: Record<string, readonly string[]>;
    readonly flatten: (input: Record<string, unknown>, output?: Record<string, unknown>) => Record<string, unknown>;
    readonly nerfDarts: readonly string[];
    readonly npmPath: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly argv: readonly string[];
    readonly warn: boolean;
  }): {
    load(): Promise<void>;
    readonly flat: Record<string, unknown>;
  };
}

interface NpmConfigDefinitionsModule {
  readonly definitions: Record<string, unknown>;
  readonly shorthands: Record<string, readonly string[]>;
  readonly flatten: (input: Record<string, unknown>, output?: Record<string, unknown>) => Record<string, unknown>;
  readonly nerfDarts: readonly string[];
}

function readNpmConfigDefinitions(value: unknown): NpmConfigDefinitionsModule {
  if (
    !isRecord(value)
    || !isRecord(value.definitions)
    || !isRecord(value.shorthands)
    || typeof value.flatten !== 'function'
    || !Array.isArray(value.nerfDarts)
  ) {
    throw new Error('@npmcli/config definitions module has an unsupported shape');
  }

  return value as unknown as NpmConfigDefinitionsModule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifestString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`npm manifest ${label} must be a non-empty string`);
  }

  return value;
}

function readOptionalManifestString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readManifestString(value, label);
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}
