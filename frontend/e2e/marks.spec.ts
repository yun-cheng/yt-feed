import { test, expect, watch, seek, pause, currentTime, clearMarks } from './fixtures'

// Bookmarks, chapters and captions over a downloaded video. The pictures are
// the point: each is a frame grabbed from the file by a real <video> and
// <canvas>, which jsdom can only pretend to do.

const VIDEO = 'e2eMarks000'

test.beforeEach(async ({ page }) => {
  await clearMarks(page, VIDEO)
  await watch(page, VIDEO)
  await pause(page)
})

test('a bookmark shows a picture of its moment, and is still there after a reload', async ({ page }) => {
  await seek(page, 5)
  await page.keyboard.press('b')

  await page.keyboard.press('g')
  const panel = page.getByRole('complementary', { name: 'Panel on the video' })
  await panel.getByRole('tab', { name: 'Bookmarks' }).click()
  const row = panel.getByRole('button', { name: /0:05/ })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('moment-thumb')).toHaveAttribute('src', /^blob:/)

  // Opened afresh: the bookmark comes back from the server, not the page.
  await watch(page, VIDEO)
  await page.keyboard.press('g')
  await panel.getByRole('tab', { name: 'Bookmarks' }).click()
  await expect(panel.getByRole('button', { name: /0:05/ })).toBeVisible()
})

test('the Chapters tab lists the chapters with their pictures, and a click seeks', async ({ page }) => {
  await page.keyboard.press('g')
  const panel = page.getByRole('complementary', { name: 'Panel on the video' })
  await panel.getByRole('tab', { name: 'Chapters' }).click()

  for (const title of ['Opening', 'Middle', 'Close']) {
    await expect(panel.getByRole('button', { name: title }).getByTestId('moment-thumb')).toHaveAttribute('src', /^blob:/)
  }
  await panel.getByRole('button', { name: 'Middle' }).click()
  await expect.poll(() => currentTime(page)).toBeGreaterThanOrEqual(7)
  expect(await currentTime(page)).toBeLessThan(8)
})

test('captions follow the play head', async ({ page }) => {
  await seek(page, 1)
  await page.keyboard.press('c')
  await expect(page.getByText('The first caption.')).toBeVisible()
  await seek(page, 5)
  await expect(page.getByText('The second caption.')).toBeVisible()
  await expect(page.getByText('The first caption.')).toBeHidden()
})
