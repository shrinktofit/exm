// @ts-check

import { defineConfig, globalIgnores } from 'eslint/config';
import stf from '@shrinktofit/eslint-config';
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
    'packages/*/test/lib',
  ]),
  stf.configs.recommended,
  node.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: [
          'packages/exm/tsconfig.json',
          'packages/exm/test/tsconfig.json',
        ],
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'packages/exm/bin/exm.js',
            'packages/exm/vitest.config.ts',
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
]);
