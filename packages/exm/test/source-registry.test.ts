import { describe, expect, it } from 'vitest';
import { createDefaultSourceRegistry } from '../src/index.js';

describe('ExtensionSourceRegistry', () => {
  it('should show supported specifiers for unsupported dependency sources', () => {
    const registry = createDefaultSourceRegistry();

    expect(() => registry.getSource('npm:@feb/example')).toThrow([
      'Unsupported exm dependency source: npm:@feb/example',
      '',
      'Supported exm dependency specifiers:',
      '  - link:../my-extension',
      '  - git+https://github.com/org/repo.git',
      '  - git+https://github.com/org/repo.git#main',
      '  - git+https://github.com/org/repo.git#abcdef1',
      '  - https://github.com/org/repo.git#abcdef1',
      '  - git@github.com:org/repo.git#abcdef1',
      '  - git+https://github.com/org/repo.git#main:packages/my-extension',
      '  - git+https://github.com/org/repo.git#abcdef1:packages/my-extension',
      '  - git+https://github.com/org/repo.git#:packages/my-extension',
    ].join('\n'));
  });
});
