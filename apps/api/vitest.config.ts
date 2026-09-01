import { defineConfig } from 'vitest/config';

const postgresCoverageOnly = process.env.POSTGRES_COVERAGE_ONLY === '1';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: postgresCoverageOnly ? ['src/persistence.ts'] : undefined,
      thresholds: postgresCoverageOnly
        ? { statements: 80, branches: 70, functions: 80, lines: 80 }
        : {
            statements: 68,
            branches: 80,
            functions: 80,
            lines: 68,
            'src/game-engine.ts': { statements: 95, branches: 80, functions: 95, lines: 95 },
            'src/store.ts': { statements: 95, branches: 78, functions: 90, lines: 95 },
            'src/table-scheduler.ts': { statements: 97, branches: 88, functions: 100, lines: 97 }
          }
    }
  }
});
