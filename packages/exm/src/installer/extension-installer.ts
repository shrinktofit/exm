import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadProjectConfig } from '../config/project-config.js';
import { assertPathInside, pathExists } from '../fs/path.js';
import { EXM_LOCAL_LOCK_FILE, createExmLockEntry, loadExmLock, saveExmLock } from '../lock/exm-lock.js';
import { createDefaultSourceRegistry, ExtensionSourceRegistry } from '../sources/registry.js';
import type { MaterializedExtension, ResolvedExtension, SourceContext } from '../sources/source.js';

export interface ExmLogger {
  info(message: string): void;
}

export interface InstallProjectExtensionsOptions {
  readonly projectRoot?: string;
  readonly cwd?: string;
  readonly installDir?: string;
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

export async function installProjectExtensions(
  options: InstallProjectExtensionsOptions = {},
): Promise<InstallProjectExtensionsResult> {
  const projectRoot = path.resolve(options.projectRoot ?? options.cwd ?? process.cwd());
  const config = await loadProjectConfig(projectRoot, {
    installDir: options.installDir,
  });
  const installRoot = path.resolve(config.projectRoot, config.installDir);
  const cacheRoot = path.join(config.projectRoot, '.exm', 'cache');
  const registry = options.registry ?? createDefaultSourceRegistry();
  const lockFileName = getProjectLockFileName(config.usesLocalLock);
  const lock = await loadExmLock(config.projectRoot, lockFileName);
  const sourceContext: SourceContext = {
    projectRoot: config.projectRoot,
    installRoot,
    cacheRoot,
  };
  const installed: MaterializedExtension[] = [];
  const adopted: MaterializedExtension[] = [];
  const skipped: string[] = [];
  const dependencyCount = Object.keys(config.dependencies).length;

  assertPathInside(config.projectRoot, installRoot, 'exm install root');
  await mkdir(installRoot, { recursive: true });

  for (const [id, spec] of Object.entries(config.dependencies)) {
    const targetPath = path.join(installRoot, id);
    assertPathInside(installRoot, targetPath, `extension target for "${id}"`);

    const source = registry.getSource(spec);
    const resolved = await source.resolve({ id, spec }, sourceContext);
    const targetExists = await pathExists(targetPath);

    if (targetExists) {
      const lockEntry = lock.extensions[id];

      if (lockEntry === undefined) {
        const adoptedMaterialized = await adoptExistingUnmanagedTarget(source, resolved, sourceContext);

        if (adoptedMaterialized !== undefined) {
          lock.extensions[id] = createExmLockEntry(resolved, adoptedMaterialized);
          adopted.push(adoptedMaterialized);
          options.logger?.info(`adopted ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, adoptedMaterialized.path)}`);
          continue;
        }

        await removeManagedTarget(installRoot, targetPath, id);
        const materialized = await source.materialize(resolved, sourceContext);
        lock.extensions[id] = createExmLockEntry(resolved, materialized);
        installed.push(materialized);
        options.logger?.info(`reinstalled ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, materialized.path)}`);
        continue;
      } else {
        if (lockEntry.spec === spec) {
          skipped.push(id);
          options.logger?.info(`skipped ${id}; already installed`);
          continue;
        }

        await removeManagedTarget(installRoot, targetPath, id);
      }
    }

    const materialized = await source.materialize(resolved, sourceContext);
    lock.extensions[id] = createExmLockEntry(resolved, materialized);
    installed.push(materialized);
    options.logger?.info(`installed ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, materialized.path)}`);
  }

  if (dependencyCount > 0) {
    await saveExmLock(config.projectRoot, lock, lockFileName);
  }

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
  const config = await loadProjectConfig(projectRoot, {
    installDir: options.installDir,
  });
  const installRoot = path.resolve(config.projectRoot, config.installDir);
  const cacheRoot = path.join(config.projectRoot, '.exm', 'cache');
  const registry = options.registry ?? createDefaultSourceRegistry();
  const lockFileName = getProjectLockFileName(config.usesLocalLock);
  const lock = await loadExmLock(config.projectRoot, lockFileName);
  const sourceContext: SourceContext = {
    projectRoot: config.projectRoot,
    installRoot,
    cacheRoot,
  };
  const updated: MaterializedExtension[] = [];
  const adopted: MaterializedExtension[] = [];
  const skipped: string[] = [];

  assertPathInside(config.projectRoot, installRoot, 'exm install root');
  await mkdir(installRoot, { recursive: true });

  for (const [id, spec] of Object.entries(config.dependencies)) {
    const source = registry.getSource(spec);
    const resolved = await source.resolve({ id, spec }, sourceContext);

    if (resolved.sourceType !== 'git') {
      skipped.push(id);
      continue;
    }

    const targetPath = path.join(installRoot, id);
    assertPathInside(installRoot, targetPath, `extension target for "${id}"`);
    const lockEntry = lock.extensions[id];
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

        await removeManagedTarget(installRoot, targetPath, id);
        const materialized = await source.materialize(resolved, sourceContext);
        lock.extensions[id] = createExmLockEntry(resolved, materialized);
        updated.push(materialized);
        options.logger?.info(`updated ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, materialized.path)}`);
        continue;
      } else {
        if (shouldReplaceTargetForUpdate(lockEntry.spec, resolved)) {
          await removeManagedTarget(installRoot, targetPath, id);
        }
      }
    }

    const materialized = await source.materialize(resolved, sourceContext);
    const nextLockEntry = createExmLockEntry(resolved, materialized);
    const didChange = lockEntryChanged(lockEntry, nextLockEntry);
    lock.extensions[id] = nextLockEntry;

    if (didChange) {
      updated.push(materialized);
      options.logger?.info(`updated ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, materialized.path)}`);
    } else {
      skipped.push(id);
      options.logger?.info(`skipped ${id}; already up to date`);
    }
  }

  if (updated.length > 0 || adopted.length > 0) {
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

function shouldReplaceTargetForUpdate(lockedSpec: string | undefined, resolved: ResolvedExtension): boolean {
  return lockedSpec !== resolved.spec;
}

function lockEntryChanged(
  previous: { readonly spec: string; readonly commit?: string } | undefined,
  next: { readonly spec: string; readonly commit?: string },
): boolean {
  return previous?.spec !== next.spec || previous.commit !== next.commit;
}

function getProjectLockFileName(usesLocalLock: boolean): string | undefined {
  return usesLocalLock ? EXM_LOCAL_LOCK_FILE : undefined;
}
