export { loadProjectConfig, readDependencies, validateExtensionId } from './config/project-config.js';
export type { ExmProjectConfig, LoadProjectConfigOptions } from './config/project-config.js';
export { installProjectExtensions } from './installer/extension-installer.js';
export type {
  ExmLogger,
  InstallProjectExtensionsOptions,
  InstallProjectExtensionsResult,
} from './installer/extension-installer.js';
export { GitExtensionSource, createGitCacheKey, parseGitSpecifier } from './sources/git-source.js';
export type { GitSpecifier, RunCommand, RunCommandOptions } from './sources/git-source.js';
export { LinkExtensionSource } from './sources/link-source.js';
export { ExtensionSourceRegistry, createDefaultSourceRegistry } from './sources/registry.js';
export type {
  ExtensionRequest,
  ExtensionSource,
  MaterializedExtension,
  ResolvedExtension,
  ResolvedGitExtension,
  SourceContext,
} from './sources/source.js';
