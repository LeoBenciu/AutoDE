import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:43117',
    locale: 'ro-RO',
    timezoneId: 'Europe/Bucharest',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      grep: /@desktop/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile-360',
      grep: /@mobile/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 360, height: 800 },
        isMobile: true,
      },
    },
  ],
  webServer: [
    {
      command: 'PORT=33117 JWT_SECRET=acceptance-test-secret npm run dev',
      cwd: '../backend',
      url: 'http://127.0.0.1:33117/api/health/ready',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        'API_PROXY_TARGET=http://127.0.0.1:33117 npm run dev -- --host 127.0.0.1 --port 43117',
      cwd: '.',
      url: 'http://127.0.0.1:43117',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
