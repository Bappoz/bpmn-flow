import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/ too: the playground's guided-run logic is not exempt from tests.
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      // Every source file, not only the ones a test happened to import — a file
      // nobody tests should drag the number down, not vanish from it.
      all: true,
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        // argv/process wiring around the tested command functions.
        '**/src/bin.ts',
        'packages/server/src/index.ts',
        // Browser wiring: DOM, file inputs and a bpmn-js modeler. The logic
        // worth testing was extracted to apps/playground/src/guided.ts.
        'apps/playground/src/main.ts',
        'apps/playground/src/editor.ts',
        'apps/playground/src/api.ts',
        'apps/playground/src/prompt.ts',
      ],
      reporter: ['text', 'json-summary'],
      // Just under the current numbers: a real drop fails, noise does not.
      thresholds: {
        statements: 89,
        branches: 79,
        functions: 90,
        lines: 91,
      },
    },
  },
});
