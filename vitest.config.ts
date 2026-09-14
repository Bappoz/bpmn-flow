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
        // Browser wiring: DOM nodes, file inputs, fetch and a bpmn-js modeler.
        // The logic worth testing was extracted to apps/playground/src/guided.ts,
        // which is the one playground module that stays in.
        'apps/playground/src/main.ts',
        'apps/playground/src/elements.ts',
        'apps/playground/src/samples.ts',
        'apps/playground/src/panel.ts',
        'apps/playground/src/run-mode.ts',
        'apps/playground/src/guided-run.ts',
        'apps/playground/src/edit-mode.ts',
        'apps/playground/src/diagram-view.ts',
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
