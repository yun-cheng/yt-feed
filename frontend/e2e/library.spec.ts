import { test, expect, nav } from './fixtures'
import type { Page } from '@playwright/test'

// What you keep: Watch Later, playlists, downloads. Each is server-side, so
// every check here is made after leaving the page that made the change — and
// each test first clears what an earlier run of it left behind.

/** The card a video title is on: the innermost block holding the title and its menu. */
const card = (page: Page, title: string) =>
  page.locator('div')
    .filter({ has: page.getByRole('link', { name: title, exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'More actions' }) })
    .last()

test('Save to Watch Later, then find it there', async ({ page }) => {
  await page.request.delete('/api/watch-later/e2eLibOne00')
  await page.goto('/')
  await page.getByRole('link', { name: 'Library one', exact: true }).first().hover()
  await page.getByRole('button', { name: 'Save to Watch Later' }).click()

  await nav(page, 'Watch Later').click()
  await expect(page.getByRole('link', { name: 'Library one', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Library two', exact: true })).toHaveCount(0)
})

test('a new playlist made from a card holds the video, and a removal can be undone', async ({ page }) => {
  for (const p of await (await page.request.get('/api/playlists')).json()) {
    if (p.name === 'E2E list') await page.request.delete(`/api/playlists/${p.id}`)
  }
  await page.goto('/')
  await card(page, 'Library two').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Save to playlist' }).click()
  await page.getByRole('button', { name: 'New playlist' }).click()
  await page.getByPlaceholder('Playlist name').fill('E2E list')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await nav(page, 'Playlists').click()
  await page.getByText('E2E list').first().click()
  await expect(page.getByRole('link', { name: 'Library two', exact: true }).first()).toBeVisible()

  await card(page, 'Library two').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Remove from playlist' }).click()
  await expect(page.getByRole('link', { name: 'Library two', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('link', { name: 'Library two', exact: true }).first()).toBeVisible()
})

test('a card names the playlists its video is saved in', async ({ page }) => {
  for (const p of await (await page.request.get('/api/playlists')).json()) {
    if (p.name === 'E2E badge') await page.request.delete(`/api/playlists/${p.id}`)
  }
  await page.goto('/')
  // The whole card, thumbnail and all — the badge sits on the thumbnail.
  const badge = page.locator('div')
    .filter({ has: page.getByRole('img', { name: 'Library one' }) })
    .filter({ has: page.getByRole('button', { name: 'More actions' }) })
    .last()
    .getByTestId('playlist-badge')
  await expect(page.getByRole('link', { name: 'Library one', exact: true }).first()).toBeVisible()
  await expect(badge).toHaveCount(0)

  await card(page, 'Library one').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Save to playlist' }).click()
  await page.getByRole('button', { name: 'New playlist' }).click()
  await page.getByPlaceholder('Playlist name').fill('E2E badge')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // Shown on a card at rest: hovering one turns it into the player.
  await page.keyboard.press('Escape')
  await page.mouse.move(0, 0)
  await expect(badge).toHaveText('E2E badge')

  // Its own playlist's page leaves it off: every card there would say it.
  await nav(page, 'Playlists').click()
  await page.getByText('E2E badge').first().click()
  await expect(page.getByRole('link', { name: 'Library one', exact: true }).first()).toBeVisible()
  await expect(badge).toHaveCount(0)

  await card(page, 'Library one').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Remove from playlist' }).click()
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Library one', exact: true }).first()).toBeVisible()
  await expect(badge).toHaveCount(0)
})

test('Downloads lists the files, and the search box narrows them', async ({ page }) => {
  await page.goto('/')
  await nav(page, 'Downloads').click()
  await expect(page.getByText('Marks video').first()).toBeVisible()
  await expect(page.getByText('Library one').first()).toBeVisible()

  // Scoped to this page, the search filters what's listed rather than asking
  // the search index (which the e2e app doesn't run).
  await page.getByPlaceholder('Search').fill('Library')
  await page.getByRole('button', { name: 'Search only downloads' }).click()
  await expect(page.getByText('Library one').first()).toBeVisible()
  await expect(page.getByText('Marks video')).toHaveCount(0)
})

test('Imported lists what was imported, and a removal can be undone', async ({ page }) => {
  await page.goto('/')
  await nav(page, 'Imported').click()
  const clip = page.getByRole('link', { name: 'Imported clip', exact: true })
  await expect(clip.first()).toBeVisible()

  await card(page, 'Imported clip').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('button', { name: 'Remove from imported' }).click()
  await expect(clip).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(clip.first()).toBeVisible()
})

// Each list's search, scoped to it, filters what it holds — seed.py's rows.
const LISTS = [
  { page: 'History', scope: 'history', query: 'Soup', kept: 'Soup in ten minutes', dropped: 'Seen it already' },
  { page: 'Watch Later', scope: 'Watch Later', query: 'Viral', kept: 'Viral today', dropped: 'Popular but older' },
  { page: 'Imported', scope: 'imported', query: 'Another', kept: 'Another import', dropped: 'Imported clip' },
]
for (const l of LISTS) {
  test(`${l.page}’s search keeps to what it lists`, async ({ page }) => {
    await page.goto('/')
    await nav(page, l.page).click()
    await expect(page.getByRole('link', { name: l.dropped, exact: true }).first()).toBeVisible()
    await page.getByPlaceholder('Search').fill(l.query)
    const scope = page.getByRole('button', { name: `Search only ${l.scope}` })
    if ((await scope.getAttribute('aria-pressed')) !== 'true') await scope.click()
    await expect(page.getByRole('link', { name: l.kept, exact: true }).first()).toBeVisible()
    await expect(page.getByRole('link', { name: l.dropped, exact: true })).toHaveCount(0)
  })
}
