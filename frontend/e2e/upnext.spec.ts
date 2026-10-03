import { test, expect, watch, seek, player } from './fixtures'
import type { Page } from '@playwright/test'

// The card that offers the channel's next video when one ends — and where it
// sits, which needs a real layout to measure.

const VIDEO = 'e2eEnding00'
const NEXT = 'e2eNextUp00'

async function playToTheEnd(page: Page) {
  await seek(page, 5)
  await player(page).evaluate((v: HTMLVideoElement) => v.play())
  await expect(page.getByTestId('up-next')).toBeVisible()
}

/** How far the card's centre is from the player's, and whether it clears the panel. */
async function placement(page: Page) {
  return page.getByTestId('up-next').evaluate((shade) => {
    const frame = shade.parentElement!.getBoundingClientRect()
    const card = shade.firstElementChild!.getBoundingClientRect()
    const panel = document.querySelector('[role="complementary"]')?.getBoundingClientRect()
    return {
      offset: (card.left + card.right) / 2 - (frame.left + frame.right) / 2,
      cardWidth: card.width,
      clearOfPanel: !panel || card.left >= panel.right || card.right <= panel.left,
    }
  })
}

test('the channel’s next video is offered at the end, and opens on a click', async ({ page }) => {
  await watch(page, VIDEO)
  await playToTheEnd(page)
  const card = page.getByTestId('up-next')
  await expect(card).toContainText('The next one')
  expect((await placement(page)).offset).toBeCloseTo(0, 0)

  await card.getByRole('button', { name: /The next one/ }).click()
  await expect(page).toHaveURL(new RegExp(`/watch/${NEXT}`))
  await expect(player(page)).toHaveAttribute('src', new RegExp(`/api/downloads/${NEXT}/file`))
})

test('Dismiss leaves the finished frame alone', async ({ page }) => {
  await watch(page, VIDEO)
  await playToTheEnd(page)
  await page.getByTestId('up-next').getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByTestId('up-next')).toBeHidden()
})

for (const side of ['left', 'right'] as const) {
  test(`with the panel open on the ${side}, the card stays in the middle of the frame`, async ({ page }) => {
    await page.addInitScript((s) => localStorage.setItem('ytfeed:video-panel-side', s), side)
    await watch(page, VIDEO)
    await page.keyboard.press('g')
    await expect(page.getByRole('complementary', { name: 'Panel on the video' })).toBeVisible()
    await playToTheEnd(page)

    const { offset, cardWidth, clearOfPanel } = await placement(page)
    expect(Math.abs(offset)).toBeLessThan(2)
    expect(cardWidth).toBeCloseTo(352, 0)
    expect(clearOfPanel).toBe(true)
  })
}
