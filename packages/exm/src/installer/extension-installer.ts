import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { EXM_INSTALL_DIR, loadProjectConfig } from '../config/project-config.js';
import { assertPathInside, pathExists } from '../fs/path.js';
import { EXM_LOCAL_LOCK_FILE, createExmLockEntry, loadExmLock, saveExmLock } from '../lock/exm-lock.js';
import { createDefaultSourceRegistry, ExtensionSourceRegistry } from '../sources/registry.js';
import { elapsedMs, formatDurationMs, nowMs } from '../timing.js';
import { resolveExmCacheRoot } from './cache-root.js';
import type { ExmLockExtension, ExmLockFile } from '../lock/exm-lock.js';
import type { MaterializedExtension, ResolvedExtension, SourceContext } from '../sources/source.js';

export interface ExmLogger {
  info(message: string): void;
}

export interface InstallProjectExtensionsOptions {
  readonly projectRoot?: string;
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly registry?: ExtensionSourceRegistry;
  readonly logger?: ExmLogger;
}

export interface InstallProjectExtensionsResult {
  readonly projectRoot: string;
  readonly installRoot: string;
  readonly installed: readonly MaterializedExtension[];
  readonly adopted: readonly MaterializedExtension[];
  readonly skipped: readonly string[];
}

export interface UpdateProjectExtensionsResult {
  readonly projectRoot: string;
  readonly installRoot: string;
  readonly updated: readonly MaterializedExtension[];
  readonly adopted: readonly MaterializedExtension[];
  readonly skipped: readonly string[];
}

interface MaterializePhaseTiming {
  readonly resolveMs: number;
  readonly removeMs?: number;
  readonly materializeMs: number;
  readonly totalMs: number;
}

export async function installProjectExtensions(
  options: InstallProjectExtensionsOptions = {},
): Promise<InstallProjectExtensionsResult> {
  const projectRoot = path.resolve(options.projectRoot ?? options.cwd ?? process.cwd());
  const config = await loadProjectConfig(projectRoot);
  const installRoot = path.resolve(config.projectRoot, EXM_INSTALL_DIR);
  const dependencyIds = Object.keys(config.dependencies);
  const dependencyCount = dependencyIds.length;

  assertPathInside(config.projectRoot, installRoot, 'exm install root');

  const lockFileName = getProjectLockFileName(config.usesLocalLock);
  const lock = await loadExmLock(config.projectRoot, lockFileName);
  const didPruneLock = pruneUnusedLockEntries(lock, dependencyIds);

  if (dependencyCount === 0) {
    if (didPruneLock) {
      await saveExmLock(config.projectRoot, lock, lockFileName);
    }

    return {
      projectRoot: config.projectRoot,
      installRoot,
      installed: [],
      adopted: [],
      skipped: [],
    };
  }

  const cacheRoot = resolveExmCacheRoot(config.projectRoot, options.cacheRoot);
  const registry = options.registry ?? createDefaultSourceRegistry();
  const sourceContext: SourceContext = {
    projectRoot: config.projectRoot,
    installRoot,
    cacheRoot,
    ...optionalStringField('exmRegistry', config.registry),
  };
  const installed: MaterializedExtension[] = [];
  const adopted: MaterializedExtension[] = [];
  const skipped: string[] = [];

  await mkdir(installRoot, { recursive: true });

  for (const [id, spec] of Object.entries(config.dependencies)) {
    const dependencyStartMs = nowMs();
    const targetPath = path.join(installRoot, id);
    assertPathInside(installRoot, targetPath, `extension target for "${id}"`);

    const lockEntry = lock.extensions[id];
    const source = registry.getSource(spec);
    const resolveStartMs = nowMs();
    const resolved = await source.resolve({ id, spec, previous: lockEntry }, sourceContext);
    const resolveMs = elapsedMs(resolveStartMs);
    let removeMs: number | undefined;
    const targetExists = await pathExists(targetPath);

    if (targetExists) {
      if (lockEntry === undefined) {
        const adoptedMaterialized = await adoptExistingUnmanagedTarget(source, resolved, sourceContext);

        if (adoptedMaterialized !== undefined) {
          lock.extensions[id] = createExmLockEntry(resolved, adoptedMaterialized);
          adopted.push(adoptedMaterialized);
          options.logger?.info(`adopted ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, adoptedMaterialized.path)}`);
          continue;
        }

        removeMs = await removeManagedTargetWithTiming(installRoot, targetPath, id, removeMs);
        const materializeStartMs = nowMs();
        const materialized = await source.materialize(resolved, sourceContext);
        const materializeMs = elapsedMs(materializeStartMs);
        const phaseTiming = {
          resolveMs,
          ...optionalNumberField('removeMs', removeMs),
          materializeMs,
          totalMs: elapsedMs(dependencyStartMs),
        };
        lock.extensions[id] = createExmLockEntry(resolved, materialized);
        installed.push(materialized);
        options.logger?.info(formatMaterializedResult('reinstalled', config.projectRoot, resolved, materialized, phaseTiming));
        continue;
      } else {
        if (lockEntry.spec === spec) {
          skipped.push(id);
          options.logger?.info(`${colorText('yellow', 'skipped')} ${id}; already installed`);
          continue;
        }

        removeMs = await removeManagedTargetWithTiming(installRoot, targetPath, id, removeMs);
      }
    }

    const materializeStartMs = nowMs();
    const materialized = await source.materialize(resolved, sourceContext);
    const materializeMs = elapsedMs(materializeStartMs);
    const phaseTiming = {
      resolveMs,
      ...optionalNumberField('removeMs', removeMs),
      materializeMs,
      totalMs: elapsedMs(dependencyStartMs),
    };
    lock.extensions[id] = createExmLockEntry(resolved, materialized);
    installed.push(materialized);
    options.logger?.info(formatMaterializedResult('installed', config.projectRoot, resolved, materialized, phaseTiming));
  }

  await saveExmLock(config.projectRoot, lock, lockFileName);

  return {
    projectRoot: config.projectRoot,
    installRoot,
    installed,
    adopted,
    skipped,
  };
}

export async function updateProjectExtensions(
  options: InstallProjectExtensionsOptions = {},
): Promise<UpdateProjectExtensionsResult> {
  const projectRoot = path.resolve(options.projectRoot ?? options.cwd ?? process.cwd());
  const config = await loadProjectConfig(projectRoot);
  const installRoot = path.resolve(config.projectRoot, EXM_INSTALL_DIR);
  const dependencyIds = Object.keys(config.dependencies);
  const dependencyCount = dependencyIds.length;

  assertPathInside(config.projectRoot, installRoot, 'exm install root');

  const lockFileName = getProjectLockFileName(config.usesLocalLock);
  const lock = await loadExmLock(config.projectRoot, lockFileName);
  const didPruneLock = pruneUnusedLockEntries(lock, dependencyIds);

  if (dependencyCount === 0) {
    if (didPruneLock) {
      await saveExmLock(config.projectRoot, lock, lockFileName);
    }

    return {
      projectRoot: config.projectRoot,
      installRoot,
      updated: [],
      adopted: [],
      skipped: [],
    };
  }

  const cacheRoot = resolveExmCacheRoot(config.projectRoot, options.cacheRoot);
  const registry = options.registry ?? createDefaultSourceRegistry();
  const sourceContext: SourceContext = {
    projectRoot: config.projectRoot,
    installRoot,
    cacheRoot,
    ...optionalStringField('exmRegistry', config.registry),
    update: true,
  };
  const updated: MaterializedExtension[] = [];
  const adopted: MaterializedExtension[] = [];
  const skipped: string[] = [];

  await mkdir(installRoot, { recursive: true });

  for (const [id, spec] of Object.entries(config.dependencies)) {
    const dependencyStartMs = nowMs();
    const lockEntry = lock.extensions[id];
    const source = registry.getSource(spec);
    const resolveStartMs = nowMs();
    const resolved = await source.resolve({ id, spec, previous: lockEntry }, sourceContext);
    const resolveMs = elapsedMs(resolveStartMs);
    let removeMs: number | undefined;

    if (resolved.sourceType === 'link') {
      skipped.push(id);
      continue;
    }

    const targetPath = path.join(installRoot, id);
    assertPathInside(installRoot, targetPath, `extension target for "${id}"`);
    const targetExists = await pathExists(targetPath);

    if (targetExists) {
      if (lockEntry === undefined) {
        const adoptedMaterialized = await adoptExistingUnmanagedTarget(source, resolved, sourceContext);

        if (adoptedMaterialized !== undefined) {
          lock.extensions[id] = createExmLockEntry(resolved, adoptedMaterialized);
          adopted.push(adoptedMaterialized);
          options.logger?.info(`adopted ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, adoptedMaterialized.path)}`);
          continue;
        }

        removeMs = await removeManagedTargetWithTiming(installRoot, targetPath, id, removeMs);
        const materializeStartMs = nowMs();
        const materialized = await source.materialize(resolved, sourceContext);
        const materializeMs = elapsedMs(materializeStartMs);
        const phaseTiming = {
          resolveMs,
          ...optionalNumberField('removeMs', removeMs),
          materializeMs,
          totalMs: elapsedMs(dependencyStartMs),
        };
        lock.extensions[id] = createExmLockEntry(resolved, materialized);
        updated.push(materialized);
        options.logger?.info(formatMaterializedResult('updated', config.projectRoot, resolved, materialized, phaseTiming));
        continue;
      } else if (resolved.sourceType === 'npm' || resolved.sourceType === 'exm') {
        const nextLockEntry = createExmLockEntry(resolved, {
          id,
          path: targetPath,
          mode: 'copy',
        });

        if (!lockEntryChanged(lockEntry, nextLockEntry)) {
          skipped.push(id);
          options.logger?.info(`${colorText('yellow', 'skipped')} ${id}; already up to date`);
          continue;
        }

        removeMs = await removeManagedTargetWithTiming(installRoot, targetPath, id, removeMs);
      } else if (shouldReplaceTargetForUpdate(lockEntry.spec, resolved)) {
        removeMs = await removeManagedTargetWithTiming(installRoot, targetPath, id, removeMs);
      }
    }

    const materializeStartMs = nowMs();
    const materialized = await source.materialize(resolved, sourceContext);
    const materializeMs = elapsedMs(materializeStartMs);
    const phaseTiming = {
      resolveMs,
      ...optionalNumberField('removeMs', removeMs),
      materializeMs,
      totalMs: elapsedMs(dependencyStartMs),
    };
    const nextLockEntry = createExmLockEntry(resolved, materialized);
    const didChange = lockEntryChanged(lockEntry, nextLockEntry);
    lock.extensions[id] = nextLockEntry;

    if (didChange) {
      updated.push(materialized);
      options.logger?.info(formatMaterializedResult('updated', config.projectRoot, resolved, materialized, phaseTiming));
    } else {
      skipped.push(id);
      options.logger?.info(`${colorText('yellow', 'skipped')} ${id}; already up to date${formatMaterializedObservation(resolved, materialized, phaseTiming)}`);
    }
  }

  if (updated.length > 0 || adopted.length > 0 || didPruneLock) {
    await saveExmLock(config.projectRoot, lock, lockFileName);
  }

  return {
    projectRoot: config.projectRoot,
    installRoot,
    updated,
    adopted,
    skipped,
  };
}

function formatMaterializedResult(
  action: 'installed' | 'reinstalled' | 'updated',
  projectRoot: string,
  resolved: ResolvedExtension,
  materialized: MaterializedExtension,
  timing: MaterializePhaseTiming,
): string {
  return `${colorAction(action)} ${materialized.id} from ${resolved.sourceType} -> ${path.relative(projectRoot, materialized.path)}${formatMaterializedObservation(resolved, materialized, timing)}`;
}

function colorAction(action: 'installed' | 'reinstalled' | 'updated'): string {
  if (action === 'reinstalled') {
    return colorText('yellow', action);
  }

  return colorText('green', action);
}

function formatMaterializedObservation(
  resolved: ResolvedExtension,
  materialized: MaterializedExtension,
  timing: MaterializePhaseTiming,
): string {
  const cache = materialized.cache;
  const sourceTiming = materialized.timing;
  const parts = [
    ...optionalCachePart(resolved, cache?.hit),
    formatTimingPart('resolve', timing.resolveMs),
    ...optionalTimingPart('remove', timing.removeMs),
    formatTimingPart('materialize', timing.materializeMs),
    ...optionalTimingPart('populate', sourceTiming?.cachePopulateMs),
    ...optionalTimingPart('copy', sourceTiming?.cacheCopyMs),
    ...optionalTimingPart('git', sourceTiming?.gitSyncMs),
    ...optionalTimingPart('link', sourceTiming?.linkMs),
    formatTimingPart('total', timing.totalMs),
  ];

  return ` [${parts.join(' ')}]`;
}

function optionalCachePart(resolved: ResolvedExtension, hit: boolean | undefined): string[] {
  if (hit === undefined) {
    return [];
  }

  if (resolved.sourceType === 'git') {
    return [hit ? colorCachePart('cache=reused', 'green') : colorCachePart('cache=populated', 'yellow')];
  }

  return [hit ? colorCachePart('cache=hit', 'green') : colorCachePart('cache=miss', 'yellow')];
}

function colorCachePart(text: string, color: AnsiColor): string {
  return colorText(color, text);
}

function optionalTimingPart(label: string, value: number | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  const color: AnsiColor = label === 'total'
    ? 'cyan'
    : label === 'copy' || label === 'populate' || label === 'remove'
      ? 'yellow'
      : 'dim';

  return [`${label}=${colorText(color, formatDurationMs(value))}`];
}

function formatTimingPart(label: string, value: number): string {
  return optionalTimingPart(label, value)[0]!;
}

type AnsiColor = 'green' | 'yellow' | 'cyan' | 'dim';

const ANSI_COLOR_CODES: Readonly<Record<AnsiColor, number>> = {
  green: 32,
  yellow: 33,
  cyan: 36,
  dim: 2,
};

function colorText(color: AnsiColor, text: string): string {
  if (!shouldUseColor()) {
    return text;
  }

  return `\u001B[${ANSI_COLOR_CODES[color]}m${text}\u001B[0m`;
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (process.env.FORCE_COLOR !== undefined) {
    return process.env.FORCE_COLOR !== '0';
  }

  return process.stdout.isTTY === true;
}

async function adoptExistingUnmanagedTarget(
  source: ReturnType<ExtensionSourceRegistry['getSource']>,
  resolved: ResolvedExtension,
  context: SourceContext,
): Promise<MaterializedExtension | undefined> {
  if (source.adoptExisting === undefined) {
    return undefined;
  }

  return await source.adoptExisting(resolved, context);
}

async function removeManagedTarget(installRoot: string, targetPath: string, id: string): Promise<void> {
  assertPathInside(installRoot, targetPath, `extension target for "${id}"`);
  await rm(targetPath, { recursive: true, force: true });
}

async function removeManagedTargetWithTiming(
  installRoot: string,
  targetPath: string,
  id: string,
  previousRemoveMs: number | undefined,
): Promise<number> {
  const removeStartMs = nowMs();
  await removeManagedTarget(installRoot, targetPath, id);

  return (previousRemoveMs ?? 0) + elapsedMs(removeStartMs);
}

function shouldReplaceTargetForUpdate(lockedSpec: string | undefined, resolved: ResolvedExtension): boolean {
  return lockedSpec !== resolved.spec;
}

function pruneUnusedLockEntries(lock: ExmLockFile, dependencyIds: readonly string[]): boolean {
  const declaredIds = new Set(dependencyIds);
  let didPrune = false;

  for (const id of Object.keys(lock.extensions)) {
    if (!declaredIds.has(id)) {
      delete lock.extensions[id];
      didPrune = true;
    }
  }

  return didPrune;
}

function lockEntryChanged(previous: ExmLockExtension | undefined, next: ExmLockExtension): boolean {
  if (previous === undefined) {
    return true;
  }

  return previous.spec !== next.spec
    || lockResolutionChanged(previous.resolution, next.resolution);
}

function lockResolutionChanged(
  previous: ExmLockExtension['resolution'],
  next: ExmLockExtension['resolution'],
): boolean {
  return previous?.commit !== next?.commit
    || previous?.version !== next?.version
    || previous?.resolved !== next?.resolved
    || previous?.integrity !== next?.integrity;
}

function getProjectLockFileName(usesLocalLock: boolean): string | undefined {
  return usesLocalLock ? EXM_LOCAL_LOCK_FILE : undefined;
}

function optionalStringField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, string>;
}

function optionalNumberField<Key extends string>(key: Key, value: number | undefined): Partial<Record<Key, number>> {
  return value === undefined ? {} : { [key]: value } as Record<Key, number>;
}
