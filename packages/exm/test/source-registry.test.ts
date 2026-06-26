import { describe, expect, it } from 'vitest';
import { createDefaultSourceRegistry } from '../src/index.js';

describe('ExtensionSourceRegistry', () => {
  it('should show supported specifiers for unsupported dependency sources', () => {
    /// @case
    /// 1. A dependency specifier does not match any supported source protocol.
    /// 2. The source registry attempts to resolve it.
    /// @expect
    /// The error lists npm, link, and git specifier examples.
    const registry = createDefaultSourceRegistry();

    expect(() => registry.getSource('workspace:tool')).toThrow([
      'Unsupported exm dependency source: workspace:tool',
      '',
      'Supported exm dependency specifiers:',
      '  - npm:@company/my-extension@1.2.3',
      '  - npm:@company/my-extension@^1.2.0',
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
