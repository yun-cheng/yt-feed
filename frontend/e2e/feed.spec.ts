import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// The feed: the followed channels' videos, inside a time window, in an order
// you pick. Its two videos (seed.py's Feed Channel) are never opened — they
// aren't downloaded — only listed.

const POPULAR = 'Popular but older'  // 5 days old, 900k views
const NEWER = 'Newer but quiet'      // 1 day old, 50 views

/** Which of `titles` the feed lists first, or null while one is missing. */
async function firstOf(page: Page, titles: string[]) {
  return page.evaluate((titles) => {
    const text = [...document.querySelectorAll('a')].map((el) => el.textContent?.trim())
    const at = titles.map((t) => text.indexOf(t))
    return at.some((i) => i < 0) ? null : titles[at.indexOf(Math.min(...at))]
  }, titles)
}
const first = (page: Page, a: string, b: string) => firstOf(page, [a, b])

test('the last 3 days by default, and a wider window brings in older videos', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: NEWER }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: POPULAR })).toHaveCount(0)

  await page.getByRole('button', { name: '1w', exact: true }).click()
  await expect(page.getByRole('link', { name: POPULAR }).first()).toBeVisible()
})

test('the sort decides the order, and survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '1w', exact: true }).click()
  await expect(page.getByRole('link', { name: POPULAR }).first()).toBeVisible()

  await page.getByRole('button', { name: 'Views', exact: true }).click()
  await expect.poll(() => first(page, POPULAR, NEWER)).toBe(POPULAR)

  await page.getByRole('button', { name: 'Newest', exact: true }).click()
  await expect.poll(() => first(page, POPULAR, NEWER)).toBe(NEWER)

  await page.reload()
  await expect(page.getByRole('link', { name: POPULAR }).first()).toBeVisible()
  await expect.poll(() => first(page, POPULAR, NEWER)).toBe(NEWER)
})

test('each sort puts its own video first', async ({ page }) => {
  // The four Feed Channel videos seed.py gave a leader each, over a week.
  const leaders: Record<string, string> = {
    Views: POPULAR, Hot: 'Viral today', Likes: 'Liked a lot', 'Like%': 'Loved but small',
  }
  const all = Object.values(leaders)
  await page.goto('/')
  await page.getByRole('button', { name: '1w', exact: true }).click()
  for (const [sort, leader] of Object.entries(leaders)) {
    await page.getByRole('button', { name: sort, exact: true }).click()
    await expect.poll(() => firstOf(page, all), { message: sort }).toBe(leader)
  }
})

test('dragging the window’s far edge brings in older videos', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: POPULAR })).toHaveCount(0)

  // The edge's handle, dragged to where "2w" sits on the scale under it.
  const handle = (await page.getByRole('slider', { name: 'Oldest edge' }).boundingBox())!
  const to = (await page.getByRole('button', { name: '2w', exact: true }).boundingBox())!
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, handle.y + handle.height / 2, { steps: 10 })
  await page.mouse.up()

  await expect(page.getByRole('link', { name: POPULAR }).first()).toBeVisible()
  await expect(page.getByText(/^Past 2w/)).toBeVisible()
})
