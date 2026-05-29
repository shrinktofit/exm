import path from 'node:path';
import { assertDirectory, createDirectoryLink, isSameRealPath } from '../fs/path.js';
import type { ExtensionRequest, ExtensionSource, MaterializedExtension, ResolvedExtension, SourceContext } from './source.js';

export class LinkExtensionSource implements ExtensionSource {
  public readonly protocol = 'link';

  public canResolve(spec: string): boolean {
    return spec.startsWith('link:');
  }

  public async resolve(request: ExtensionRequest, context: SourceContext): Promise<ResolvedExtension> {
    const rawPath = request.spec.slice('link:'.length);

    if (rawPath.length === 0) {
      throw new Error(`link source for "${request.id}" must include a local path`);
    }

    const sourcePath = path.resolve(context.projectRoot, rawPath);
    await assertDirectory(sourcePath, `link source for "${request.id}"`);

    return {
      id: request.id,
      spec: request.spec,
      sourceType: this.protocol,
      reference: sourcePath,
      sourcePath,
    };
  }

  public async adoptExisting(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension | undefined> {
    const targetPath = path.join(context.installRoot, resolved.id);

    if (!await isSameRealPath(resolved.sourcePath, targetPath)) {
      return undefined;
    }

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'link',
    };
  }

  public async materialize(resolved: ResolvedExtension, context: SourceContext): Promise<MaterializedExtension> {
    const targetPath = path.join(context.installRoot, resolved.id);
    await createDirectoryLink(resolved.sourcePath, targetPath);

    return {
      id: resolved.id,
      path: targetPath,
      mode: 'link',
    };
  }
}
