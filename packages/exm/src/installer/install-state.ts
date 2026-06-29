import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedExtension } from '../sources/source.js';

export const EXM_INSTALL_STATE_FILE = path.join('temp', '.exm', 'install-state.json');

export interface ExmInstallStateFile {
  readonly schemaVersion: 1;
  readonly extensions: Record<string, ExmInstallStateEntry>;
}

export type ExmInstallStateEntry = ExmInstallStateExmEntry | ExmInstallStateNpmEntry;

export interface ExmInstallStateExmEntry {
  readonly sourceType: 'exm';
  readonly spec: string;
  readonly version: string;
  readonly integrity: string;
  readonly resolved?: undefined;
}

export interface ExmInstallStateNpmEntry {
  readonly sourceType: 'npm';
  readonly spec: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity?: string;
}

export async function loadInstallState(projectRoot: string): Promise<ExmInstallStateFile> {
  const statePath = getInstallStatePath(projectRoot);
  let content: string;

  try {
    content = await readFile(statePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return createEmptyInstallState();
    }

    throw new Error(`Failed to read exm install state: ${statePath}`, { cause: error });
  }

  try {
    return normalizeInstallState(JSON.parse(content), statePath);
  } catch (error) {
    throw new Error(`Failed to parse exm install state: ${statePath}`, { cause: error });
  }
}

export async function saveInstallState(projectRoot: string, state: ExmInstallStateFile): Promise<void> {
  const statePath = getInstallStatePath(projectRoot);
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(sortInstallState(state), null, 2)}\n`);
}

export function getInstallStatePath(projectRoot: string): string {
  return path.join(projectRoot, EXM_INSTALL_STATE_FILE);
}

export function createInstallStateEntry(resolved: ResolvedExtension): ExmInstallStateEntry | undefined {
  if (resolved.exm !== undefined) {
    return {
      sourceType: 'exm',
      spec: resolved.spec,
      version: resolved.exm.version,
      integrity: resolved.exm.integrity,
    };
  }

  if (resolved.npm !== undefined) {
    return {
      sourceType: 'npm',
      spec: resolved.spec,
      version: resolved.npm.version,
      resolved: resolved.npm.resolved,
      ...optionalStringField('integrity', resolved.npm.integrity),
    };
  }

  return undefined;
}

export function installStateEntryMatches(
  actual: ExmInstallStateEntry | undefined,
  expected: ExmInstallStateEntry,
): boolean {
  return actual?.sourceType === expected.sourceType
    && actual.spec === expected.spec
    && actual.version === expected.version
    && actual.integrity === expected.integrity
    && actual.resolved === expected.resolved;
}

export function setInstallStateEntry(
  state: ExmInstallStateFile,
  id: string,
  next: ExmInstallStateEntry,
): boolean {
  if (installStateEntryMatches(state.extensions[id], next)) {
    return false;
  }

  state.extensions[id] = next;
  return true;
}

export function deleteInstallStateEntry(state: ExmInstallStateFile, id: string): boolean {
  if (state.extensions[id] === undefined) {
    return false;
  }

  delete state.extensions[id];
  return true;
}

export function pruneInstallStateEntries(state: ExmInstallStateFile, dependencyIds: readonly string[]): boolean {
  const declaredIds = new Set(dependencyIds);
  let didPrune = false;

  for (const id of Object.keys(state.extensions)) {
    if (!declaredIds.has(id)) {
      delete state.extensions[id];
      didPrune = true;
    }
  }

  return didPrune;
}

function createEmptyInstallState(): ExmInstallStateFile {
  return {
    schemaVersion: 1,
    extensions: {},
  };
}

function normalizeInstallState(value: unknown, statePath: string): ExmInstallStateFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.extensions)) {
    throw new Error(`Invalid exm install state schema: ${statePath}`);
  }

  const extensions: Record<string, ExmInstallStateEntry> = {};

  for (const [id, entry] of Object.entries(value.extensions)) {
    extensions[id] = normalizeInstallStateEntry(id, entry, statePath);
  }

  return {
    schemaVersion: 1,
    extensions,
  };
}

function normalizeInstallStateEntry(id: string, value: unknown, statePath: string): ExmInstallStateEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid exm install state entry for "${id}": ${statePath}`);
  }

  if (value.sourceType === 'exm') {
    if (typeof value.spec !== 'string' || typeof value.version !== 'string' || typeof value.integrity !== 'string') {
      throw new Error(`Invalid exm install state entry for "${id}": ${statePath}`);
    }

    return {
      sourceType: 'exm',
      spec: value.spec,
      version: value.version,
      integrity: value.integrity,
    };
  }

  if (value.sourceType === 'npm') {
    if (typeof value.spec !== 'string' || typeof value.version !== 'string' || typeof value.resolved !== 'string') {
      throw new Error(`Invalid exm install state entry for "${id}": ${statePath}`);
    }

    if (value.integrity !== undefined && typeof value.integrity !== 'string') {
      throw new Error(`Invalid exm install state entry for "${id}": ${statePath}`);
    }

    return {
      sourceType: 'npm',
      spec: value.spec,
      version: value.version,
      resolved: value.resolved,
      ...optionalStringField('integrity', value.integrity),
    };
  }

  throw new Error(`Invalid exm install state source for "${id}": ${statePath}`);
}

function sortInstallState(state: ExmInstallStateFile): ExmInstallStateFile {
  return {
    schemaVersion: 1,
    extensions: Object.fromEntries(Object.entries(state.extensions).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
