import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { pathExists } from '../fs/path.js';
import type { MaterializedExtension, ResolvedExtension } from '../sources/source.js';

export const EXM_LOCK_FILE = 'exm-lock.yaml';
export const EXM_LOCAL_LOCK_FILE = 'exm-lock.local.yaml';

export interface ExmLockFile {
  readonly lockFileVersion: 1;
  readonly extensions: Record<string, ExmLockExtension>;
}

export interface ExmLockExtension {
  readonly source: string;
  readonly spec: string;
  readonly registry?: string;
  readonly commit?: string;
  readonly packageName?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly size?: number;
}

export async function loadExmLock(
  projectRoot: string,
  lockFileName = EXM_LOCK_FILE,
): Promise<ExmLockFile> {
  const lockPath = getExmLockPath(projectRoot, lockFileName);

  if (!await pathExists(lockPath)) {
    return createEmptyExmLock();
  }

  let parsed: unknown;

  try {
    parsed = parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read ${lockFileName}`, { cause: error });
  }

  return normalizeExmLock(parsed, lockFileName);
}

export async function saveExmLock(
  projectRoot: string,
  lock: ExmLockFile,
  lockFileName = EXM_LOCK_FILE,
): Promise<void> {
  const normalizedLock: ExmLockFile = {
    lockFileVersion: 1,
    extensions: Object.fromEntries(Object.entries(lock.extensions).sort(([left], [right]) => left.localeCompare(right))),
  };
  await writeFile(getExmLockPath(projectRoot, lockFileName), stringify(normalizedLock), 'utf8');
}

export function createExmLockEntry(
  resolved: ResolvedExtension,
  materialized: MaterializedExtension,
): ExmLockExtension {
  if (resolved.exm !== undefined) {
    return {
      source: 'exm',
      spec: resolved.spec,
      registry: resolved.exm.registry,
      packageName: resolved.exm.packageName,
      version: resolved.exm.version,
      resolved: resolved.exm.resolved,
      integrity: resolved.exm.integrity,
      size: resolved.exm.size,
    };
  }

  if (resolved.npm !== undefined) {
    return {
      source: 'npm',
      spec: resolved.spec,
      packageName: resolved.npm.packageName,
      version: resolved.npm.version,
      resolved: resolved.npm.resolved,
      ...optionalStringField('integrity', resolved.npm.integrity),
    };
  }

  if (resolved.git !== undefined) {
    const commit = materialized.git?.commit;

    if (commit === undefined) {
      throw new Error(`Git extension "${resolved.id}" did not resolve to a commit`);
    }

    return {
      source: 'git',
      spec: resolved.spec,
      commit,
    };
  }

  return {
    source: resolved.sourceType,
    spec: resolved.spec,
  };
}

export function getExmLockPath(projectRoot: string, lockFileName = EXM_LOCK_FILE): string {
  return path.join(projectRoot, lockFileName);
}

function createEmptyExmLock(): ExmLockFile {
  return {
    lockFileVersion: 1,
    extensions: {},
  };
}

function normalizeExmLock(value: unknown, lockFileName: string): ExmLockFile {
  if (!isRecord(value)) {
    throw new Error(`${lockFileName} must contain an object`);
  }

  if (value.lockFileVersion !== 1) {
    throw new Error(`${lockFileName} lockFileVersion must be 1`);
  }

  if (!isRecord(value.extensions)) {
    throw new Error(`${lockFileName} extensions must be an object`);
  }

  const extensions: Record<string, ExmLockExtension> = {};

  for (const [id, extension] of Object.entries(value.extensions)) {
    extensions[id] = normalizeExmLockExtension(lockFileName, id, extension);
  }

  return {
    lockFileVersion: 1,
    extensions,
  };
}

function normalizeExmLockExtension(lockFileName: string, id: string, value: unknown): ExmLockExtension {
  if (!isRecord(value)) {
    throw new Error(`${lockFileName} extension "${id}" must be an object`);
  }

  return {
    source: readString(lockFileName, value.source, id, 'source'),
    spec: readString(lockFileName, value.spec, id, 'spec'),
    ...optionalStringField('registry', readOptionalString(lockFileName, value, id, 'registry')),
    ...optionalStringField('commit', readOptionalString(lockFileName, value, id, 'commit')),
    ...optionalStringField('packageName', readOptionalString(lockFileName, value, id, 'packageName')),
    ...optionalStringField('version', readOptionalString(lockFileName, value, id, 'version')),
    ...optionalStringField('resolved', readOptionalString(lockFileName, value, id, 'resolved')),
    ...optionalStringField('integrity', readOptionalString(lockFileName, value, id, 'integrity')),
    ...optionalNumberField('size', readOptionalNumber(lockFileName, value, id, 'size')),
  };
}

function readOptionalString(
  lockFileName: string,
  value: Record<string, unknown>,
  id: string,
  field: string,
): string | undefined {
  if (value[field] === undefined) {
    return undefined;
  }

  return readString(lockFileName, value[field], id, field);
}

function readOptionalNumber(
  lockFileName: string,
  value: Record<string, unknown>,
  id: string,
  field: string,
): number | undefined {
  if (value[field] === undefined) {
    return undefined;
  }

  const fieldValue = value[field];

  if (typeof fieldValue !== 'number' || !Number.isInteger(fieldValue)) {
    throw new Error(`${lockFileName} extension "${id}" ${field} must be an integer`);
  }

  return fieldValue;
}

function readString(lockFileName: string, value: unknown, id: string, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${lockFileName} extension "${id}" ${field} must be a string`);
  }

  return value;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function optionalNumberField<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
