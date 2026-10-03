import { test, expect, watch } from './fixtures'
import type { Page } from '@playwright/test'

// A phone: built for a desktop, the app still has to fit a 375px screen
// without scrolling sideways, and keep its way around reachable.

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const path of ['/', '/settings', '/history', '/downloads']) {
  test(`${path} fits the width`, async ({ page }) => {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    expect(await overflow(page)).toBeLessThanOrEqual(0)
  })
}

test('the watch page fits', async ({ page }) => {
  await watch(page, 'e2ePlayer00')
  expect(await overflow(page)).toBeLessThanOrEqual(0)
})

test('the sidebar opens from its button', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await expect(page.getByRole('button', { name: 'History', exact: true }).first()).toBeInViewport()
})
