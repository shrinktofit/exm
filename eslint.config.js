// @ts-check

import { defineConfig, globalIgnores } from 'eslint/config';
import stf from '@shrinktofit/eslint-config';
import vue from '@shrinktofit/eslint-config/vue';
import node from '@shrinktofit/eslint-config/node';

export default defineConfig([
  {
    settings: {
      node: {
        version: '>=22.17.0',
      },
    },
  },
  globalIgnores([
    'node_modules',
    'packages/*/lib',
  ]),
  stf.configs.recommended,
  vue.configs.recommended,
  node.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          'packages/*/tsconfig.json',
          'packages/*/test/tsconfig.json',
          'packages/*/scripts/tsconfig.json',
        ],
        projectService: {
          allowDefaultProject: [
            'env.d.ts',
            'eslint.config.js',
            'vitest.workspace.ts',
            'packages/*/vite.config.ts',
            'packages/*/vitest.config.ts',
            'packages/exm/bin/exm.js',
            'packages/eslint/*.js',
            'packages/stf-eslint/*.js',
          ],
        },
      },
    },
  },
  {
    rules: {
      'n/no-extraneous-import': 'off',
    },
  },
  {
    files: [
      '**/*.vue',
    ],
    rules: {
      'n/no-unsupported-features/node-builtins': 'off',
    },
  },
]);
