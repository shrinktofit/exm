export { initProjectConfig } from './config/init-project.js';
export type { InitProjectConfigOptions, InitProjectConfigResult, InitProjectConfigStatus } from './config/init-project.js';
export { EXM_INSTALL_DIR, EXM_LOCAL_FILE, loadProjectConfig, readDependencies, validateExtensionId } from './config/project-config.js';
export type { ExmProjectConfig } from './config/project-config.js';
export { installProjectExtensions, updateProjectExtensions } from './installer/extension-installer.js';
export type {
  ExmLogger,
  InstallProjectExtensionsOptions,
  InstallProjectExtensionsResult,
  UpdateProjectExtensionsResult,
} from './installer/extension-installer.js';
export { EXM_LOCAL_LOCK_FILE, EXM_LOCK_FILE, createExmLockEntry, getExmLockPath, loadExmLock, saveExmLock } from './lock/exm-lock.js';
export type { ExmLockExtension, ExmLockFile } from './lock/exm-lock.js';
export { deployExtensionPackage, publishExtensionPackage } from './publisher/extension-publisher.js';
export type {
  DeployExtensionPackageOptions,
  DeployExtensionPackageResult,
  PublishCommandOptions,
  PublishCommandRunner,
  PublishExtensionPackageOptions,
  PublishExtensionPackageResult,
} from './publisher/extension-publisher.js';
export { ExmRegistrySource, HttpExmRegistryClient, NpmRegistryFetchRemoteClient, SemverExmVersionRange, createEmptyExmRegistryIndex, createExmRegistryArtifactPath, createExmRegistryArtifactUrl, createExmRegistryIndexUrl, createSha512IntegrityFromBuffer, createSha512IntegrityFromFile, normalizeExmRegistryIndex, normalizeExmRegistryUrl, parseExmRegistrySpecifier } from './sources/exm-registry-source.js';
export type { DownloadedArtifact, ExmRegistryArtifact, ExmRegistryClient, ExmRegistryIndex, ExmRegistryPackageRequest, ExmRegistryRemoteClient, ExmRegistrySpecifier, ExmRegistryVersion, ExmVersionRange } from './sources/exm-registry-source.js';
export { GitExtensionSource, createGitCacheKey, parseGitSpecifier } from './sources/git-source.js';
export type { GitSpecifier, RunCommand, RunCommandOptions } from './sources/git-source.js';
export { LinkExtensionSource } from './sources/link-source.js';
export { NpmExtensionSource, PacoteNpmPackageClient, SemverNpmVersionRange, parseNpmSpecifier } from './sources/npm-source.js';
export type { NpmPackageClient, NpmPackageRequest, NpmSpecifier, NpmVersionRange } from './sources/npm-source.js';
export { ExtensionSourceRegistry, createDefaultSourceRegistry } from './sources/registry.js';
export { formatSupportedDependencySpecifiers, withSupportedDependencySpecifiers } from './sources/specifier-help.js';
export type {
  ExtensionRequest,
  ExtensionSource,
  MaterializedExtension,
  MaterializedGitExtension,
  PreviousResolvedExtension,
  ResolvedExmRegistryExtension,
  ResolvedExtension,
  ResolvedGitExtension,
  ResolvedNpmExtension,
  SourceContext,
} from './sources/source.js';
