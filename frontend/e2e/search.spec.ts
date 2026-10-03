import { test, expect } from './fixtures'

// Search, through the Meilisearch serve.sh starts beside the app — indexed
// from the seeded feed when the app comes up. Skipped where there's no
// meilisearch binary to start.

test.beforeEach(async ({ request }) => {
  const up = await request.get('http://127.0.0.1:7709/health').then((r) => r.ok(), () => false)
  test.skip(!up, 'no meilisearch to search with')
})

// "minuts": one letter short. Meilisearch forgives a typo only in a word of
// five letters or more, so a misspelt "soup" would find nothing.
for (const query of ['soup', 'minuts']) {
  test(`"${query}" finds the video${query === 'minuts' ? ', typo and all' : ''}`, async ({ page }) => {
    await page.goto('/')
    await page.getByPlaceholder('Search').fill(query)
    await page.keyboard.press('Enter')
    await expect(page.getByRole('link', { name: 'Soup in ten minutes', exact: true }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: 'Newer but quiet', exact: true })).toHaveCount(0)
  })
}
