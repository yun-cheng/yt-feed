import { test, expect, watch, seek, currentTime, nav } from './fixtures'
import type { Page } from '@playwright/test'

// Watch history: where you stopped is kept, a video reopens there, and the
// History page lists it — and can give back what you took off it.

const VIDEO = 'e2eHist0000'  // 60 seconds

/** Leave the video at `seconds` — leaving reports the position on the way
 *  out — and wait for the server to have it. */
async function leaveAt(page: Page, seconds: number) {
  await seek(page, seconds)
  await page.goBack()
  await expect.poll(async () => (await (await page.request.get(`/api/history/${VIDEO}`)).json()).position_seconds)
    .toBeCloseTo(seconds, 0)
}

test('a video reopens where it was left', async ({ page }) => {
  await watch(page, VIDEO)
  await leaveAt(page, 25)
  await page.goto(`/watch/${VIDEO}`)
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(24)
})

test('left near its end, a video starts over', async ({ page }) => {
  await watch(page, VIDEO)
  await leaveAt(page, 50)
  await page.goto(`/watch/${VIDEO}`)
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0)
  expect(await currentTime(page)).toBeLessThan(10)
})

test('History lists what was watched, and a removal can be undone', async ({ page }) => {
  await watch(page, VIDEO)
  await leaveAt(page, 12)

  // Back went to where the browser came from: nothing, on a cold load.
  await page.goto('/')
  await nav(page, 'History').click()
  const title = page.getByRole('link', { name: 'History video', exact: true })
  await expect(title.first()).toBeVisible()

  const card = page.locator('div')
    .filter({ has: page.getByRole('link', { name: 'History video', exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'More actions' }) })
    .last()
  await card.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Remove from history' }).click()
  await expect(title).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(title.first()).toBeVisible()
})
