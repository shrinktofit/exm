import path from 'node:path';
import { readJsonObject, isJsonObject } from './package-json.js';

export interface ExmProjectConfig {
  readonly projectRoot: string;
  readonly installDir: string;
  readonly dependencies: Readonly<Record<string, string>>;
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
  const exm = packageJson.exm;

  if (exm === undefined) {
    return {
      projectRoot: resolvedProjectRoot,
      installDir: options.installDir ?? 'extensions',
      dependencies: {},
    };
  }

  if (!isJsonObject(exm)) {
    throw new Error('package.json exm field must be an object');
  }

  const dependencies = readDependencies(exm.dependencies);
  const installDir = options.installDir ?? readInstallDir(exm.installDir);

  return {
    projectRoot: resolvedProjectRoot,
    installDir,
    dependencies,
  };
}

export function readDependencies(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) {
    return {};
  }

  if (!isJsonObject(value)) {
    throw new Error('package.json exm.dependencies must be an object');
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
