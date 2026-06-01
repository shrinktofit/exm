import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parse, stringify } from 'yaml';
import { pathExists } from '../fs/path.js';
import { EXM_LOCAL_FILE, readDependencies } from './project-config.js';
import { isJsonObject, readJsonObject, writeJsonObject } from './package-json.js';
import type { JsonObject, JsonValue } from './package-json.js';

export type InitProjectConfigStatus = 'initialized' | 'updated' | 'unchanged';

export interface InitProjectConfigOptions {
  readonly projectRoot?: string;
  readonly installDir?: string;
  readonly local?: boolean;
}

export interface InitProjectConfigResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly local: boolean;
  readonly status: InitProjectConfigStatus;
}

export async function initProjectConfig(
  options: InitProjectConfigOptions = {},
): Promise<InitProjectConfigResult> {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const installDir = validateInstallDir(options.installDir);

  if (options.local === true) {
    return await initLocalConfig(projectRoot, installDir);
  }

  return await initPackageConfig(projectRoot, installDir);
}

async function initPackageConfig(
  projectRoot: string,
  installDir: string | undefined,
): Promise<InitProjectConfigResult> {
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJson = await readJsonObject(packageJsonPath);
  const nextPackageJson: Record<string, JsonValue> = { ...packageJson };
  const currentExm = packageJson.exm;
  const initialExm = currentExm === undefined;
  const exm = normalizeExmConfig(currentExm, 'package.json exm field');
  const nextExm = applyInitDefaults(exm, installDir);
  const changed = initialExm || !jsonEquals(exm, nextExm);

  if (changed) {
    nextPackageJson.exm = nextExm;
    await writeJsonObject(packageJsonPath, nextPackageJson);
  }

  return {
    projectRoot,
    configPath: packageJsonPath,
    local: false,
    status: getInitStatus(initialExm, changed),
  };
}

async function initLocalConfig(
  projectRoot: string,
  installDir: string | undefined,
): Promise<InitProjectConfigResult> {
  await readJsonObject(path.join(projectRoot, 'package.json'));

  const localPath = path.join(projectRoot, EXM_LOCAL_FILE);
  const exists = await pathExists(localPath);
  const currentExm = exists ? await readLocalConfig(localPath) : undefined;
  const exm = normalizeExmConfig(currentExm, EXM_LOCAL_FILE);
  const nextExm = applyInitDefaults(exm, installDir);
  const changed = !exists || !jsonEquals(exm, nextExm);

  if (changed) {
    await writeFile(localPath, stringify(nextExm), 'utf8');
  }

  return {
    projectRoot,
    configPath: localPath,
    local: true,
    status: getInitStatus(!exists, changed),
  };
}

async function readLocalConfig(localPath: string): Promise<unknown> {
  try {
    return parse(await readFile(localPath, 'utf8')) ?? {};
  } catch (error) {
    throw new Error(`Failed to read ${EXM_LOCAL_FILE}`, { cause: error });
  }
}

function normalizeExmConfig(value: unknown, label: string): JsonObject {
  if (value === undefined) {
    return {};
  }

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }

  const dependencies = value.dependencies;

  if (dependencies !== undefined) {
    readDependencies(dependencies, `${label} dependencies`);
  }

  validateExistingInstallDir(value.installDir, `${label} installDir`);

  return value;
}

function applyInitDefaults(exm: JsonObject, installDir: string | undefined): JsonObject {
  const nextExm: Record<string, JsonValue> = { ...exm };

  if (nextExm.dependencies === undefined) {
    nextExm.dependencies = {};
  }

  if (installDir !== undefined) {
    nextExm.installDir = installDir;
  }

  return nextExm;
}

function validateInstallDir(installDir: string | undefined): string | undefined {
  if (installDir === undefined) {
    return undefined;
  }

  validateExistingInstallDir(installDir, 'exm installDir');

  return installDir;
}

function validateExistingInstallDir(value: JsonValue | undefined, label: string): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }

  if (path.isAbsolute(value)) {
    throw new Error(`${label} must be relative to the project root`);
  }
}

function getInitStatus(initial: boolean, changed: boolean): InitProjectConfigStatus {
  if (!changed) {
    return 'unchanged';
  }

  return initial ? 'initialized' : 'updated';
}

function jsonEquals(left: JsonObject, right: JsonObject): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
