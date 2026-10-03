import { fileURLToPath } from 'node:url'
import { test, expect, player, currentTime } from './fixtures'

// A folder on the backend's machine, added by path: scanned, probed by
// ffprobe for each file's length, and played from the file.

const MEDIA = fileURLToPath(new URL('./.run/media', import.meta.url))

test('an added folder lists its files with their lengths, and plays one', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Local', exact: true }).first().click()
  await page.getByPlaceholder('/Users/you/Movies/lessons').fill(MEDIA)
  await page.getByRole('button', { name: 'Add folder' }).click()

  await page.getByText('media', { exact: true }).first().click()
  await expect(page.getByText('Clip one').first()).toBeVisible()
  await expect(page.getByText('Clip two').first()).toBeVisible()
  // The lengths come from probing the files, after the scan.
  await expect(page.getByText('0:08').first()).toBeVisible()
  await expect(page.getByText('0:05').first()).toBeVisible()

  await page.getByText('Clip one').first().click()
  await expect(player(page)).toHaveAttribute('src', /\/api\/local\/videos\/[^/]+\/file/)
  await expect.poll(() => currentTime(page)).toBeGreaterThan(0)
})
