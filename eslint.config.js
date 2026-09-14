import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  // Type-aware rules: no-floating-promises, no-misused-promises and
  // await-thenable only exist with a program behind them, and this codebase is
  // full of async.
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.lint.json',
          './packages/*/tsconfig.lint.json',
          './apps/*/tsconfig.lint.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // JavaScript has no program to check against.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Exemplos executaveis rodam no Node, fora do build TypeScript.
    files: ['examples/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
