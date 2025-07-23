import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadProjectConfig } from '../config/project-config.js';
import { assertPathInside, pathExists } from '../fs/path.js';
import { createDefaultSourceRegistry, ExtensionSourceRegistry } from '../sources/registry.js';
import type { MaterializedExtension, SourceContext } from '../sources/source.js';

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
  const sourceContext: SourceContext = {
    projectRoot: config.projectRoot,
    installRoot,
    cacheRoot,
  };
  const installed: MaterializedExtension[] = [];

  assertPathInside(config.projectRoot, installRoot, 'exm install root');
  await mkdir(installRoot, { recursive: true });

  for (const [id, spec] of Object.entries(config.dependencies)) {
    const targetPath = path.join(installRoot, id);
    assertPathInside(installRoot, targetPath, `extension target for "${id}"`);

    if (await pathExists(targetPath)) {
      throw new Error(`Extension target already exists: ${targetPath}`);
    }

    const source = registry.getSource(spec);
    const resolved = await source.resolve({ id, spec }, sourceContext);
    const materialized = await source.materialize(resolved, sourceContext);
    installed.push(materialized);
    options.logger?.info(`installed ${id} from ${resolved.sourceType} -> ${path.relative(config.projectRoot, materialized.path)}`);
  }

  return {
    projectRoot: config.projectRoot,
    installRoot,
    installed,
  };
}
