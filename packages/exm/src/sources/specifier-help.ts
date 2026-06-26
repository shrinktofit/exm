const supportedDependencySpecifierExamples = [
  'npm:@company/my-extension@1.2.3',
  'npm:@company/my-extension@^1.2.0',
  'link:../my-extension',
  'git+https://github.com/org/repo.git',
  'git+https://github.com/org/repo.git#main',
  'git+https://github.com/org/repo.git#abcdef1',
  'https://github.com/org/repo.git#abcdef1',
  'git@github.com:org/repo.git#abcdef1',
  'git+https://github.com/org/repo.git#main:packages/my-extension',
  'git+https://github.com/org/repo.git#abcdef1:packages/my-extension',
  'git+https://github.com/org/repo.git#:packages/my-extension',
] as const;

export function formatSupportedDependencySpecifiers(): string {
  return [
    'Supported exm dependency specifiers:',
    ...supportedDependencySpecifierExamples.map((example) => `  - ${example}`),
  ].join('\n');
}

export function withSupportedDependencySpecifiers(message: string): string {
  return `${message}\n\n${formatSupportedDependencySpecifiers()}`;
}
