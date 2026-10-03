import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

// The sidebar's filters and the Videos / Shorts switch, each narrowing the
// feed to what it says — over seed.py's tags, watch history, lengths and one
// finished summary.

const title = (page: Page, name: string) => page.getByRole('link', { name, exact: true })
const shown = (page: Page, name: string) => expect(title(page, name).first()).toBeVisible()
const gone = (page: Page, name: string) => expect(title(page, name)).toHaveCount(0)
/** A sidebar chip: an icon and a label, and a count while it's not picked
 *  ("🍜 food 1"). Not the − beside it, whose name is "Hide food". */
const chip = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^(?!Hide )\\S+ ${label}( \\d+)?$`) })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await shown(page, 'Newer but quiet')
})

test('Shorts is a feed of its own', async ({ page }) => {
  await gone(page, 'A short one')
  await page.getByRole('button', { name: 'Shorts', exact: true }).click()
  await shown(page, 'A short one')
  await gone(page, 'Newer but quiet')
})

test('the watched stay hidden until Watched is picked', async ({ page }) => {
  await gone(page, 'Seen it already')
  await shown(page, 'Soup in ten minutes')  // in progress

  await chip(page, 'Watched').click()
  await shown(page, 'Seen it already')
  // Unwatched off leaves the two that have been started.
  await chip(page, 'Unwatched').click()
  await gone(page, 'Newer but quiet')
  await shown(page, 'Soup in ten minutes')
  await shown(page, 'Seen it already')
})

test('a length keeps to the videos that long', async ({ page }) => {
  await chip(page, '5–10 min').click()
  await shown(page, 'Soup in ten minutes')  // 6:40
  await gone(page, 'Newer but quiet')       // 1:00
})

test('a tag keeps to its channels, and its − leaves them out', async ({ page }) => {
  await chip(page, 'food').click()
  await shown(page, 'Soup in ten minutes')
  await gone(page, 'Newer but quiet')

  await chip(page, 'food').click()
  await page.getByRole('button', { name: 'Hide food' }).click()
  await gone(page, 'Soup in ten minutes')
  await shown(page, 'Newer but quiet')
})

test('Summarised keeps to the videos with a summary', async ({ page }) => {
  await chip(page, 'Summarised').click()
  await shown(page, 'Soup in ten minutes')
  await gone(page, 'Newer but quiet')
})
