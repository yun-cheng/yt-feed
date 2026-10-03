import { test, expect, watch, seek, pause, clearMarks, keepSettings } from './fixtures'
import type { Locator, Page } from '@playwright/test'

// How features look, one feature to a picture — what the DOM can't say: a
// mark's shape and where it sits on the track, the caption box, a chip's
// three states. Each is compared against a baseline in e2e/__screenshots__,
// made on this machine; `npx playwright test visual --update-snapshots`
// remakes them after a change that was meant.
//
// Kept still on purpose: the video paused (and its picture hidden, see
// screenshot.css), the data seeded, nothing hovered that isn't the subject.

/** A box around an element, grown by `pad` — for the track, whose pins and
 *  passage markers stand above and below the bar they're on. */
async function around(el: Locator, pad: number) {
  const b = (await el.boundingBox())!
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
}

/** The marks video with two bookmarks and a passage, paused between them. */
async function marked(page: Page) {
  await clearMarks(page, 'e2eMarks000')
  await watch(page, 'e2eMarks000')
  await pause(page)
  // 13, not 12: at 10 the head would count as standing on it (2s either side).
  for (const t of [5, 13]) {
    await seek(page, t)
    await page.keyboard.press('b')
  }
  await seek(page, 3)
  await page.keyboard.press('[')
  await seek(page, 8)
  await page.keyboard.press(']')
  // Pinning the end starts it repeating, and playing: let go, so the passage
  // is drawn at rest, and stop on a moment that isn't a mark.
  await page.keyboard.press('\\')
  await pause(page)
  await seek(page, 10)
}

test.describe('the marks', () => {
  test.beforeEach(async ({ page }) => { await marked(page) })

  test('on the progress bar: pins, the passage, the chapter gaps', async ({ page }) => {
    await page.mouse.move(0, 0)
    const rail = page.getByTestId('track-rail')
    await expect(page.getByTestId('bookmark-pin')).toHaveCount(2)
    await expect(page).toHaveScreenshot('progress-bar-marks.png', { clip: await around(rail, 14) })
  })

  test('the bookmark menu, each row with its picture', async ({ page }) => {
    await page.getByRole('button', { name: 'Bookmark this moment' }).hover()
    const menu = page.getByTestId('bookmark-menu')
    await expect(menu.locator('img[data-testid="moment-thumb"]')).toHaveCount(2)
    await expect(menu).toHaveScreenshot('bookmark-menu.png')
  })

  test('the repeat menu, its passage with its picture', async ({ page }) => {
    await page.getByRole('button', { name: /^Repeat A–B/ }).hover()
    const menu = page.getByTestId('loop-menu')
    await expect(menu.locator('img[data-testid="moment-thumb"]')).toHaveCount(1)
    await expect(menu).toHaveScreenshot('repeat-menu.png')
  })
})

test.describe('the captions', () => {
  test.beforeEach(async ({ page }) => {
    // The same video as the marks: without theirs, so the bar is bare.
    await clearMarks(page, 'e2eMarks000')
    await watch(page, 'e2eMarks000')
    await pause(page)
    await seek(page, 1)
    await page.keyboard.press('c')
    await page.mouse.move(0, 0)
  })

  test('drawn the way YouTube draws them', async ({ page }) => {
    const line = page.getByText('The first caption.')
    await expect(line).toBeVisible()
    await expect(line).toHaveScreenshot('caption-line.png')
  })

  test('centred on the whole picture beside the panel', async ({ page }) => {
    await page.keyboard.press('g')
    const panel = page.getByRole('complementary', { name: 'Panel on the video' })
    await expect(panel.getByRole('tab', { name: 'Comments' })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByText('Skip to 0:12 for the good part.')).toBeVisible()
    // The player: the panel's box is its height, and the player's its width.
    const player = page.locator('video').first().locator('xpath=..')
    await expect(page).toHaveScreenshot('caption-beside-panel.png', { clip: (await player.boundingBox())! })
  })
})

test('the up-next card', async ({ page }) => {
  await watch(page, 'e2eEnding00')
  await seek(page, 5)
  await page.locator('video').first().evaluate((v: HTMLVideoElement) => v.play())
  const card = page.getByTestId('up-next').locator('> div')
  await expect(card).toContainText('The next one')
  await page.mouse.move(0, 0)
  await expect(card).toHaveScreenshot('up-next-card.png')
})

test('a tag chip: off, picked, and left out', async ({ page }) => {
  await page.goto('/')
  const hide = page.getByRole('button', { name: 'Hide food' })
  const show = page.getByRole('button', { name: /^(?!Hide )\S+ food( \d+)?$/ })
  // Held by the chip, whose name stays put; the − renames itself once used.
  const pair = show.locator('..')
  await page.mouse.move(0, 0)
  await expect(pair).toHaveScreenshot('tag-chip-off.png')
  await show.click()
  await page.mouse.move(0, 0)
  await expect(pair).toHaveScreenshot('tag-chip-picked.png')
  await show.click()
  await hide.click()
  await page.mouse.move(0, 0)
  await expect(pair).toHaveScreenshot('tag-chip-excluded.png')
})

test('a video card in the light theme', async ({ page }) => {
  const restore = await keepSettings(page, ['theme'])
  try {
    await page.request.put('/api/settings', { data: { values: { theme: 'light' } } })
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    // "Newer but quiet": 50 views over a day reads 2.1 v/h for hours either
    // side of when the seed made it, where a busier card's rate would tick
    // over within a run.
    // The whole card: its thumbnail, and the lines and menu under it.
    const card = page.locator('div')
      .filter({ has: page.getByRole('img', { name: 'Newer but quiet' }) })
      .filter({ has: page.getByRole('button', { name: 'More actions' }) })
      .last()
    // Lifted out of the grid to the corner, at a width whose 16:9 thumbnail
    // is a whole number of pixels high. Where the grid puts it depends on
    // what else the page holds (other specs leave a preset in the sidebar),
    // and at a fractional position or height the picture shifts by a pixel
    // for reasons that have nothing to do with the card.
    await card.evaluate((el) => {
      Object.assign(el.style, {
        position: 'fixed', left: '0', top: '0', width: '480px', zIndex: '9999',
        background: getComputedStyle(document.body).backgroundColor,
      })
    })
    await page.mouse.move(0, 0)
    await expect(card).toHaveScreenshot('card-light.png')
  } finally {
    await restore()
  }
})
