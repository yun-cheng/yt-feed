import { defineConfig } from '@playwright/test'

// End-to-end: a real browser against the real backend, over a scratch feed of
// its own (e2e/serve.sh). What jsdom can't do — play a video, grab its frames,
// lay out a page — is what these are for.
const PORT = Number(process.env.E2E_PORT || 8765)

export default defineConfig({
  testDir: './e2e',
  // One app, one database: the specs keep to their own videos, but a second
  // worker would still be a second browser on the same account.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
    // visual.spec.ts: one feature per picture, compared against a baseline
    // made on this machine. A pixel counts as changed at a small colour
    // difference — the default (0.2) let the caption box go from 75% to 50%
    // opaque unnoticed — and a small share of changed pixels absorbs
    // antialiasing.
    toHaveScreenshot: {
      animations: 'disabled',
      threshold: 0.05,
      maxDiffPixelRatio: 0.01,
      scale: 'css',
      stylePath: './e2e/screenshot.css',
    },
  },
  // In e2e/__screenshots__, named for the feature, with the platform: a
  // baseline is only good for the system (and Chrome) that drew it.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{platform}{ext}',
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    storageState: './e2e/.run/state.json',
    // Google Chrome rather than Playwright's Chromium: Chromium can't decode
    // H.264, which is what a download is. It's also already installed, so the
    // suite needs no browser download of its own.
    channel: 'chrome',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'bash e2e/serve.sh',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { E2E_PORT: String(PORT) },
    // Always a fresh one: the feed is seeded at start, and a server left from
    // an earlier run has that run's bookmarks and history in it.
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
