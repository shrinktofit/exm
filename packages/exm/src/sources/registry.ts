import { GitExtensionSource } from './git-source.js';
import { LinkExtensionSource } from './link-source.js';
import type { ExtensionSource } from './source.js';

export class ExtensionSourceRegistry {
  public constructor(private readonly sources: readonly ExtensionSource[]) {}

  public getSource(spec: string): ExtensionSource {
    const source = this.sources.find((candidate) => candidate.canResolve(spec));

    if (source === undefined) {
      throw new Error(`Unsupported exm dependency source: ${spec}`);
    }

    return source;
  }
}

export function createDefaultSourceRegistry(): ExtensionSourceRegistry {
  return new ExtensionSourceRegistry([
    new LinkExtensionSource(),
    new GitExtensionSource(),
  ]);
}
