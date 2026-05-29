export interface ExtensionRequest {
  readonly id: string;
  readonly spec: string;
}

export interface SourceContext {
  readonly projectRoot: string;
  readonly installRoot: string;
  readonly cacheRoot: string;
}

export interface ResolvedExtension {
  readonly id: string;
  readonly spec: string;
  readonly sourceType: string;
  readonly reference: string;
  readonly sourcePath: string;
  readonly git?: ResolvedGitExtension;
}

export interface ResolvedGitExtension {
  readonly url: string;
  readonly ref?: string;
  readonly subpath?: string;
}

export interface MaterializedExtension {
  readonly id: string;
  readonly path: string;
  readonly mode: 'clone' | 'link';
  readonly git?: MaterializedGitExtension;
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
