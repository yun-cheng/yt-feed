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

test('a notice above the page rides in the top bar, where it can be seen and dismissed', async ({ page }) => {
  // The scratch server holds no YouTube token, so it always has this to say.
  // Out of the fixed bar, the bar covered it and its height opened a gap
  // above the page instead.
  await page.goto('/')
  const notice = page.getByText(/YouTube API token is expired/)
  const bar = page.locator('div.fixed.top-0.z-20').first()
  const box = async (l: typeof bar) => (await l.boundingBox())!
  await expect(notice).toBeInViewport()
  const [n, b] = [await box(notice), await box(bar)]
  expect(n.y).toBeGreaterThanOrEqual(b.y)
  expect(n.y + n.height).toBeLessThanOrEqual(b.y + b.height)
  // The page starts where the bar ends, notice or no notice.
  const page1st = page.getByText('Past 3d').first()
  const gap = async () => (await box(page1st)).y - ((await box(bar)).y + (await box(bar)).height)
  expect(await gap()).toBeLessThan(30)

  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await expect.poll(gap).toBeLessThan(30)
})
