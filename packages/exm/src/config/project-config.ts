import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { pathExists } from '../fs/path.js';
import { readJsonObject, isJsonObject } from './package-json.js';

export const EXM_LOCAL_FILE = 'exm.local.yaml';
export const EXM_INSTALL_DIR = 'extensions';

export interface ExmProjectConfig {
  readonly projectRoot: string;
  readonly registry?: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly usesLocalLock: boolean;
}

export async function loadProjectConfig(
  projectRoot: string,
): Promise<ExmProjectConfig> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const packageJson = await readJsonObject(path.join(resolvedProjectRoot, 'package.json'));
  const packageExm = readExmObject(packageJson.exm, 'package.json exm field');
  const localExm = await readLocalExmObject(resolvedProjectRoot);
  rejectInstallDir(packageExm?.installDir, 'package.json exm.installDir');
  rejectInstallDir(localExm?.installDir, `${EXM_LOCAL_FILE} installDir`);
  const registry = readRegistry(packageExm?.registry, 'package.json exm.registry');
  rejectLocalRegistry(localExm?.registry);
  const packageDependencies = readDependencies(packageExm?.dependencies);
  const localDependencies = readDependencies(localExm?.dependencies, `${EXM_LOCAL_FILE} dependencies`);
  const dependencies = {
    ...packageDependencies,
    ...localDependencies,
  };
  const usesLocalLock = hasLocalDependencyEffect(packageDependencies, localDependencies);

  return {
    projectRoot: resolvedProjectRoot,
    ...optionalStringField('registry', registry),
    dependencies,
    usesLocalLock,
  };
}

export function readDependencies(
  value: unknown,
  label = 'package.json exm.dependencies',
): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  const dependencies: Record<string, string> = {};

  for (const [id, spec] of Object.entries(value)) {
    validateExtensionId(id);

    if (typeof spec !== 'string') {
      throw new Error(`exm dependency "${id}" must use a string source specifier`);
    }

    if (spec.length === 0) {
      throw new Error(`exm dependency "${id}" source specifier must not be empty`);
    }

    dependencies[id] = spec;
  }

  return dependencies;
}

export function validateExtensionId(id: string): void {
  if (id.length === 0) {
    throw new Error('exm dependency id must not be empty');
  }

  if (id === '.' || id === '..') {
    throw new Error(`Invalid exm dependency id "${id}"`);
  }

  if (id.includes('/') || id.includes('\\') || id.includes(':')) {
    throw new Error(`exm dependency id "${id}" must be a single path segment`);
  }
}

function readExmObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

async function readLocalExmObject(projectRoot: string): Promise<Record<string, unknown> | undefined> {
  const localPath = path.join(projectRoot, EXM_LOCAL_FILE);

  if (!await pathExists(localPath)) {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = parse(await readFile(localPath, 'utf8')) ?? {};
  } catch (error) {
    throw new Error(`Failed to read ${EXM_LOCAL_FILE}`, { cause: error });
  }

  return readExmObject(parsed, EXM_LOCAL_FILE);
}

function rejectInstallDir(value: unknown, label: string): void {
  if (value === undefined) {
    return;
  }

  throw new Error(`${label} is no longer supported; remove it because exm always installs into ${EXM_INSTALL_DIR}`);
}

function rejectLocalRegistry(value: unknown): void {
  if (value === undefined) {
    return;
  }

  throw new Error(`${EXM_LOCAL_FILE} registry is not supported; set package.json exm.registry instead`);
}

function readRegistry(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must be an http or https URL`);
  }

  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function hasLocalDependencyEffect(
  packageDependencies: Readonly<Record<string, string>>,
  localDependencies: Readonly<Record<string, string>>,
): boolean {
  for (const [id, localSpec] of Object.entries(localDependencies)) {
    if (packageDependencies[id] !== localSpec) {
      return true;
    }
  }

  return false;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}
