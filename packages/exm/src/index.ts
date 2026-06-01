export { initProjectConfig } from './config/init-project.js';
export type { InitProjectConfigOptions, InitProjectConfigResult, InitProjectConfigStatus } from './config/init-project.js';
export { EXM_LOCAL_FILE, loadProjectConfig, readDependencies, validateExtensionId } from './config/project-config.js';
export type { ExmProjectConfig, LoadProjectConfigOptions } from './config/project-config.js';
export { installProjectExtensions, updateProjectExtensions } from './installer/extension-installer.js';
export type {
  ExmLogger,
  InstallProjectExtensionsOptions,
  InstallProjectExtensionsResult,
  UpdateProjectExtensionsResult,
} from './installer/extension-installer.js';
export { EXM_LOCAL_LOCK_FILE, EXM_LOCK_FILE, createExmLockEntry, getExmLockPath, loadExmLock, saveExmLock } from './lock/exm-lock.js';
export type { ExmLockExtension, ExmLockFile } from './lock/exm-lock.js';
export { GitExtensionSource, createGitCacheKey, parseGitSpecifier } from './sources/git-source.js';
export type { GitSpecifier, RunCommand, RunCommandOptions } from './sources/git-source.js';
export { LinkExtensionSource } from './sources/link-source.js';
export { ExtensionSourceRegistry, createDefaultSourceRegistry } from './sources/registry.js';
export { formatSupportedDependencySpecifiers, withSupportedDependencySpecifiers } from './sources/specifier-help.js';
export type {
  ExtensionRequest,
  ExtensionSource,
  MaterializedExtension,
  MaterializedGitExtension,
  ResolvedExtension,
  ResolvedGitExtension,
  SourceContext,
} from './sources/source.js';
