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
  readonly spec: string;
  readonly resolution?: ExmLockResolution;
}

export interface ExmLockResolution {
  readonly commit?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
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
      spec: resolved.spec,
      resolution: {
        version: resolved.exm.version,
        integrity: resolved.exm.integrity,
      },
    };
  }

  if (resolved.npm !== undefined) {
    return {
      spec: resolved.spec,
      resolution: {
        version: resolved.npm.version,
        resolved: resolved.npm.resolved,
        ...optionalStringField('integrity', resolved.npm.integrity),
      },
    };
  }

  if (resolved.git !== undefined) {
    const commit = materialized.git?.commit;

    if (commit === undefined) {
      throw new Error(`Git extension "${resolved.id}" did not resolve to a commit`);
    }

    return {
      spec: resolved.spec,
      resolution: {
        commit,
      },
    };
  }

  return {
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

  const spec = readString(lockFileName, value.spec, id, 'spec');
  const resolution = normalizeResolutionForSpec(lockFileName, id, spec, value.resolution);

  return {
    spec,
    ...optionalResolutionField(resolution),
  };
}

function normalizeResolutionForSpec(
  lockFileName: string,
  id: string,
  spec: string,
  value: unknown,
): ExmLockResolution | undefined {
  if (spec.startsWith('exm:')) {
    const resolution = readResolutionRecord(lockFileName, id, value);

    return {
      version: readString(lockFileName, resolution.version, id, 'resolution.version'),
      integrity: readString(lockFileName, resolution.integrity, id, 'resolution.integrity'),
    };
  }

  if (spec.startsWith('npm:')) {
    const resolution = readResolutionRecord(lockFileName, id, value);

    return {
      version: readString(lockFileName, resolution.version, id, 'resolution.version'),
      resolved: readString(lockFileName, resolution.resolved, id, 'resolution.resolved'),
      ...optionalStringField('integrity', readOptionalString(lockFileName, resolution, id, 'resolution.integrity', 'integrity')),
    };
  }

  if (spec.startsWith('link:')) {
    if (value !== undefined) {
      throw new Error(`${lockFileName} extension "${id}" resolution is not supported for link specs`);
    }

    return undefined;
  }

  const resolution = readResolutionRecord(lockFileName, id, value);

  return {
    commit: readString(lockFileName, resolution.commit, id, 'resolution.commit'),
  };
}

function readResolutionRecord(lockFileName: string, id: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${lockFileName} extension "${id}" resolution must be an object`);
  }

  return value;
}

function readOptionalString(
  lockFileName: string,
  value: Record<string, unknown>,
  id: string,
  field: string,
  key = field,
): string | undefined {
  if (value[key] === undefined) {
    return undefined;
  }

  return readString(lockFileName, value[key], id, field);
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

function optionalResolutionField(value: ExmLockResolution | undefined): { readonly resolution?: ExmLockResolution } {
  return value === undefined ? {} : { resolution: value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
