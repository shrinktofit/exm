export interface ExtensionRequest {
  readonly id: string;
  readonly spec: string;
  readonly previous?: PreviousResolvedExtension;
}

export interface PreviousResolvedExtension {
  readonly spec: string;
  readonly resolution?: PreviousResolvedExtensionResolution;
}

export interface PreviousResolvedExtensionResolution {
  readonly commit?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
}

export interface SourceContext {
  readonly projectRoot: string;
  readonly installRoot: string;
  readonly cacheRoot: string;
  readonly exmRegistry?: string;
  readonly update?: boolean;
}

export interface ResolvedExtension {
  readonly id: string;
  readonly spec: string;
  readonly sourceType: string;
  readonly reference: string;
  readonly sourcePath: string;
  readonly git?: ResolvedGitExtension;
  readonly npm?: ResolvedNpmExtension;
  readonly exm?: ResolvedExmRegistryExtension;
}

export interface ResolvedGitExtension {
  readonly url: string;
  readonly ref?: string;
  readonly subpath?: string;
}

export interface ResolvedNpmExtension {
  readonly packageName: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity?: string;
}

export interface ResolvedExmRegistryExtension {
  readonly registry: string;
  readonly packageName: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly size?: number;
}

export interface MaterializedExtension {
  readonly id: string;
  readonly path: string;
  readonly mode: 'clone' | 'link' | 'copy';
  readonly git?: MaterializedGitExtension;
  readonly cache?: MaterializedExtensionCache;
  readonly timing?: MaterializedExtensionTiming;
}

export interface MaterializedExtensionCache {
  readonly path: string;
  readonly hit: boolean;
}

export interface MaterializedExtensionTiming {
  readonly cachePopulateMs?: number;
  readonly cacheCopyMs?: number;
  readonly gitSyncMs?: number;
  readonly linkMs?: number;
}

export interface MaterializedGitExtension {
  readonly commit: string;
}

export interface ExtensionSource {
  readonly protocol: string;

  canResolve(spec: string): boolean;

  resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension>;

  adoptExisting?(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension | undefined>;

  materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension>;
}
