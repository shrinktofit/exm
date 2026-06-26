import { ExmRegistrySource } from './exm-registry-source.js';
import { GitExtensionSource } from './git-source.js';
import { LinkExtensionSource } from './link-source.js';
import { NpmExtensionSource } from './npm-source.js';
import { withSupportedDependencySpecifiers } from './specifier-help.js';
import type { ExtensionSource } from './source.js';

export class ExtensionSourceRegistry {
  public constructor(private readonly sources: readonly ExtensionSource[]) {}

  public getSource(spec: string): ExtensionSource {
    const source = this.sources.find((candidate) => candidate.canResolve(spec));

    if (source === undefined) {
      throw new Error(withSupportedDependencySpecifiers(
        `Unsupported exm dependency source: ${spec}`,
      ));
    }

    return source;
  }
}

export function createDefaultSourceRegistry(): ExtensionSourceRegistry {
  return new ExtensionSourceRegistry([
    new LinkExtensionSource(),
    new ExmRegistrySource(),
    new NpmExtensionSource(),
    new GitExtensionSource(),
  ]);
}
