import process from 'node:process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { normalizeRegistryUrl } from './model.js';
import { FileRegistryStorage, NexusRawStorage } from './storage.js';
import type { RegistryStorage } from './storage.js';

const DEFAULT_CONFIG_FILES = ['exm-registry-server.yaml', 'exm-registry-server.yml'];
type StorageKind = 'file' | 'nexus';

export interface ExmRegistryServerEnvironmentConfig {
  readonly publicUrl: string;
  readonly port: number;
  readonly host: string;
  readonly storage: RegistryStorage;
}

export interface LoadEnvironmentConfigOptions {
  readonly configPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface ExmRegistryServerConfigFile {
  readonly publicUrl?: string;
  readonly listen?: {
    readonly host?: string;
    readonly port?: number;
  };
  readonly storage?: {
    readonly kind?: StorageKind;
    readonly root?: string;
  };
  readonly nexus?: {
    readonly baseUrl?: string;
    readonly metadataRepository?: string;
    readonly artifactRepository?: string;
    readonly username?: string;
    readonly password?: string;
    readonly token?: string;
  };
}

export async function loadEnvironmentConfig(options: LoadEnvironmentConfigOptions = {}): Promise<ExmRegistryServerEnvironmentConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configFile = await loadConfigFile({
    cwd,
    env,
    ...optionalStringField('configPath', options.configPath),
  });
  const publicUrl = readRequiredConfigString(env.EXM_REGISTRY_PUBLIC_URL ?? configFile.publicUrl, 'publicUrl / EXM_REGISTRY_PUBLIC_URL');
  const port = readPositiveInteger(env.EXM_REGISTRY_PORT ?? configFile.listen?.port ?? 4873, 'listen.port / EXM_REGISTRY_PORT');
  const storageKind = readStorageKind(env.EXM_REGISTRY_STORAGE_KIND ?? configFile.storage?.kind ?? getDefaultStorageKind(env, configFile), 'storage.kind / EXM_REGISTRY_STORAGE_KIND');

  return {
    publicUrl: normalizeRegistryUrl(publicUrl, 'publicUrl / EXM_REGISTRY_PUBLIC_URL'),
    port,
    host: readConfigString(env.EXM_REGISTRY_HOST ?? configFile.listen?.host ?? '0.0.0.0', 'listen.host / EXM_REGISTRY_HOST'),
    storage: createStorage(storageKind, cwd, env, configFile),
  };
}

async function loadConfigFile(options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly configPath?: string }): Promise<ExmRegistryServerConfigFile> {
  const configPath = await resolveConfigPath(options);

  if (configPath === undefined) {
    return {};
  }

  try {
    const parsed = parseYaml(await readFile(configPath, 'utf8')) as unknown;

    return normalizeConfigFile(parsed ?? {}, configPath);
  } catch (error) {
    throw new Error(`Failed to read exm registry server config ${configPath}`, { cause: error });
  }
}

async function resolveConfigPath(options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly configPath?: string }): Promise<string | undefined> {
  const explicitPath = options.configPath ?? options.env.EXM_REGISTRY_SERVER_CONFIG;

  if (explicitPath !== undefined && explicitPath.length > 0) {
    return path.resolve(options.cwd, explicitPath);
  }

  for (const fileName of DEFAULT_CONFIG_FILES) {
    const candidate = path.resolve(options.cwd, fileName);

    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking for the next default config name.
    }
  }

  return undefined;
}

function createStorage(storageKind: StorageKind, cwd: string, env: NodeJS.ProcessEnv, configFile: ExmRegistryServerConfigFile): RegistryStorage {
  if (storageKind === 'file') {
    const root = readRequiredConfigString(env.EXM_REGISTRY_FILE_ROOT ?? configFile.storage?.root ?? '/data', 'storage.root / EXM_REGISTRY_FILE_ROOT');

    return new FileRegistryStorage({ root: path.resolve(cwd, root) });
  }

  const nexusBaseUrl = readRequiredConfigString(env.EXM_NEXUS_BASE_URL ?? configFile.nexus?.baseUrl, 'nexus.baseUrl / EXM_NEXUS_BASE_URL');
  const metadataRepository = readConfigString(env.EXM_NEXUS_METADATA_REPOSITORY ?? configFile.nexus?.metadataRepository ?? 'exm-registry', 'nexus.metadataRepository / EXM_NEXUS_METADATA_REPOSITORY');
  const artifactRepository = readConfigString(env.EXM_NEXUS_ARTIFACT_REPOSITORY ?? configFile.nexus?.artifactRepository ?? 'exm-artifacts', 'nexus.artifactRepository / EXM_NEXUS_ARTIFACT_REPOSITORY');

  return new NexusRawStorage({
    nexusBaseUrl,
    metadataRepository,
    artifactRepository,
    ...optionalStringField('username', env.EXM_NEXUS_USERNAME ?? configFile.nexus?.username),
    ...optionalStringField('password', env.EXM_NEXUS_PASSWORD ?? configFile.nexus?.password),
    ...optionalStringField('token', env.EXM_NEXUS_TOKEN ?? configFile.nexus?.token),
  });
}

function getDefaultStorageKind(env: NodeJS.ProcessEnv, configFile: ExmRegistryServerConfigFile): StorageKind {
  return hasNexusConfig(env, configFile) ? 'nexus' : 'file';
}

function hasNexusConfig(env: NodeJS.ProcessEnv, configFile: ExmRegistryServerConfigFile): boolean {
  return configFile.nexus !== undefined
    || env.EXM_NEXUS_BASE_URL !== undefined
    || env.EXM_NEXUS_METADATA_REPOSITORY !== undefined
    || env.EXM_NEXUS_ARTIFACT_REPOSITORY !== undefined
    || env.EXM_NEXUS_USERNAME !== undefined
    || env.EXM_NEXUS_PASSWORD !== undefined
    || env.EXM_NEXUS_TOKEN !== undefined;
}

function normalizeConfigFile(value: unknown, label: string): ExmRegistryServerConfigFile {
  if (!isRecord(value)) {
    throw new Error(`${label} must contain a YAML object`);
  }

  return {
    ...optionalStringField('publicUrl', readOptionalString(value.publicUrl, `${label} publicUrl`)),
    ...optionalConfigObjectField('listen', normalizeListenConfig(value.listen, `${label} listen`)),
    ...optionalConfigObjectField('storage', normalizeStorageConfig(value.storage, `${label} storage`)),
    ...optionalConfigObjectField('nexus', normalizeNexusConfig(value.nexus, `${label} nexus`)),
  };
}

function normalizeListenConfig(value: unknown, label: string): ExmRegistryServerConfigFile['listen'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    ...optionalStringField('host', readOptionalString(value.host, `${label}.host`)),
    ...optionalNumberField('port', readOptionalPort(value.port, `${label}.port`)),
  };
}

function normalizeStorageConfig(value: unknown, label: string): ExmRegistryServerConfigFile['storage'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    ...optionalStorageKindField(readOptionalStorageKind(value.kind, `${label}.kind`)),
    ...optionalStringField('root', readOptionalString(value.root, `${label}.root`)),
  };
}

function normalizeNexusConfig(value: unknown, label: string): ExmRegistryServerConfigFile['nexus'] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return {
    ...optionalStringField('baseUrl', readOptionalString(value.baseUrl, `${label}.baseUrl`)),
    ...optionalStringField('metadataRepository', readOptionalString(value.metadataRepository, `${label}.metadataRepository`)),
    ...optionalStringField('artifactRepository', readOptionalString(value.artifactRepository, `${label}.artifactRepository`)),
    ...optionalStringField('username', readOptionalString(value.username, `${label}.username`)),
    ...optionalStringField('password', readOptionalString(value.password, `${label}.password`)),
    ...optionalStringField('token', readOptionalString(value.token, `${label}.token`)),
  };
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readConfigString(value, label);
}

function readOptionalPort(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readPositiveInteger(value, label);
}

function readOptionalStorageKind(value: unknown, label: string): StorageKind | undefined {
  if (value === undefined) {
    return undefined;
  }

  return readStorageKind(value, label);
}

function readRequiredConfigString(value: unknown, label: string): string {
  if (value === undefined) {
    throw new Error(`${label} is required`);
  }

  return readConfigString(value, label);
}

function readConfigString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return value;
}

function readStorageKind(value: unknown, label: string): StorageKind {
  if (value !== 'file' && value !== 'nexus') {
    throw new Error(`${label} must be "file" or "nexus"`);
  }

  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }

  return number;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function optionalNumberField<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}

function optionalStorageKindField(value: StorageKind | undefined): Partial<Record<'kind', StorageKind>> {
  return value === undefined ? {} : { kind: value };
}

function optionalConfigObjectField<Key extends string, Value extends object>(key: Key, value: Value | undefined): Partial<Record<Key, Value>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, Value>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
