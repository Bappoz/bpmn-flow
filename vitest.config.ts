import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/ too: the playground's guided-run logic is not exempt from tests.
    projects: ['packages/*', 'apps/*'],
  },
});
