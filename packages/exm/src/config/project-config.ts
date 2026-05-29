import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { pathExists } from '../fs/path.js';
import { readJsonObject, isJsonObject } from './package-json.js';

export const EXM_LOCAL_FILE = 'exm.local.yaml';

export interface ExmProjectConfig {
  readonly projectRoot: string;
  readonly installDir: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly usesLocalLock: boolean;
}

export interface LoadProjectConfigOptions {
  readonly installDir?: string;
}

export async function loadProjectConfig(
  projectRoot: string,
  options: LoadProjectConfigOptions = {},
): Promise<ExmProjectConfig> {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const packageJson = await readJsonObject(path.join(resolvedProjectRoot, 'package.json'));
  const packageExm = readExmObject(packageJson.exm, 'package.json exm field');
  const localExm = await readLocalExmObject(resolvedProjectRoot);
  const packageDependencies = readDependencies(packageExm?.dependencies);
  const localDependencies = readDependencies(localExm?.dependencies, `${EXM_LOCAL_FILE} dependencies`);
  const dependencies = {
    ...packageDependencies,
    ...localDependencies,
  };
  const installDir = options.installDir ?? readInstallDir(localExm?.installDir ?? packageExm?.installDir);
  const usesLocalLock = hasLocalDependencyEffect(packageDependencies, localDependencies);

  return {
    projectRoot: resolvedProjectRoot,
    installDir,
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

function readInstallDir(value: unknown): string {
  if (value === undefined) {
    return 'extensions';
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('package.json exm.installDir must be a non-empty string');
  }

  if (path.isAbsolute(value)) {
    throw new Error('package.json exm.installDir must be relative to the project root');
  }

  return value;
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
