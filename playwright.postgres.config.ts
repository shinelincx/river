import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/production-persistence.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'npm run build -w @river/api && node scripts/e2e-api-supervisor.mjs',
      url: 'http://127.0.0.1:3000/api/me',
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: 'npm run dev:web',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 120_000
    }
  ],
  projects: [{ name: 'chromium-production-postgres', use: { ...devices['Desktop Chrome'] } }]
});
