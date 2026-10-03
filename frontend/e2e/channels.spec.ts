import { test, expect } from './fixtures'

// The channels you follow: their list, a channel's own page, and keeping one
// off the feed.

const HIDEABLE = 'UCe2eHideable0000000000'

test('Channels lists the followed channels, and its search narrows them', async ({ page }) => {
  await page.goto('/channels')
  await expect(page.getByRole('heading', { name: 'Cooking Channel' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Feed Channel' })).toBeVisible()

  await page.getByPlaceholder('Search').fill('cook')
  await expect(page.getByRole('heading', { name: 'Cooking Channel' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Feed Channel' })).toHaveCount(0)
})

test('a channel’s page lists its own videos', async ({ page }) => {
  await page.goto('/channels')
  await page.getByRole('heading', { name: 'Cooking Channel' }).click()
  await expect(page).toHaveURL(/\/channel\/UCe2eCooking00000000000/)
  await expect(page.getByRole('link', { name: 'Soup in ten minutes', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Newer but quiet', exact: true })).toHaveCount(0)
})

test('Hide channel takes its videos off the feed', async ({ page }) => {
  await page.request.delete(`/api/hidden-channels/${HIDEABLE}`)
  try {
    await page.goto('/')
    const video = page.getByRole('link', { name: 'Hide me', exact: true })
    await expect(video.first()).toBeVisible()

    const card = page.locator('div')
      .filter({ has: video })
      .filter({ has: page.getByRole('button', { name: 'More actions' }) })
      .last()
    await card.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('button', { name: 'Hide channel' }).click()
    await expect(video).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('link', { name: 'Newer but quiet', exact: true }).first()).toBeVisible()
    await expect(video).toHaveCount(0)
  } finally {
    await page.request.delete(`/api/hidden-channels/${HIDEABLE}`)
  }
})
