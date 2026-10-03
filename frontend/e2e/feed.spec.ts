import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// The feed: the followed channels' videos, inside a time window, in an order
// you pick. Its two videos (seed.py's Feed Channel) are never opened — they
// aren't downloaded — only listed.

const POPULAR = 'Popular but older'  // 5 days old, 900k views
const NEWER = 'Newer but quiet'      // 1 day old, 50 views

/** Which of two titles the feed lists first. */
async function first(page: Page, a: string, b: string) {
  return page.evaluate(([a, b]) => {
    const text = [...document.querySelectorAll('a')].map((el) => el.textContent?.trim())
    const ia = text.indexOf(a)
    const ib = text.indexOf(b)
    return ia < 0 || ib < 0 ? null : ia < ib ? a : b
  }, [a, b])
}

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
