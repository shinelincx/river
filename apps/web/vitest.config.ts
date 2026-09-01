import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/clipboard.ts', 'src/invite-route.ts', 'src/table-view.ts', 'src/table-sound-events.ts'],
      thresholds: {
        statements: 90,
        branches: 65,
        functions: 100,
        lines: 90
      }
    }
  }
});
