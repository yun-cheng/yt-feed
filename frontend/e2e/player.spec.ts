import { test, expect, watch, seek, pause, player, currentTime } from './fixtures'
import type { Page } from '@playwright/test'

// The player's keys, on a real <video>: what each does to the element itself.

const VIDEO = 'e2ePlayer00'
/** A property of the <video>, read off the element itself. */
const prop = (page: Page, key: 'paused' | 'muted' | 'volume' | 'playbackRate') =>
  player(page).evaluate((v, k) => (v as HTMLVideoElement)[k], key)

test.beforeEach(async ({ page }) => {
  await watch(page, VIDEO)
})

test('k pauses and plays', async ({ page }) => {
  await page.keyboard.press('k')
  await expect.poll(() => prop(page, 'paused')).toBe(true)
  await page.keyboard.press('k')
  await expect.poll(() => prop(page, 'paused')).toBe(false)
})

test('the seek keys move the play head by their step', async ({ page }) => {
  await pause(page)
  await seek(page, 12)
  await page.keyboard.press('l')
  await expect.poll(() => currentTime(page)).toBeCloseTo(22, 0)
  await page.keyboard.press('j')
  await expect.poll(() => currentTime(page)).toBeCloseTo(12, 0)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => currentTime(page)).toBeCloseTo(7, 0)
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => currentTime(page)).toBeCloseTo(12, 0)
})

test('. and , step the speed, and the bar says so', async ({ page }) => {
  await page.keyboard.press('.')
  await expect.poll(() => prop(page, 'playbackRate')).toBeGreaterThan(1)
  const faster = await prop(page, 'playbackRate')
  await expect(page.getByRole('button', { name: 'Playback speed' })).toContainText(String(faster))
  await page.keyboard.press(',')
  await expect.poll(() => prop(page, 'playbackRate')).toBe(1)
})

test('m mutes and unmutes, and the arrows set the volume', async ({ page }) => {
  await page.keyboard.press('m')
  await expect.poll(() => prop(page, 'muted')).toBe(true)
  await page.keyboard.press('m')
  await expect.poll(() => prop(page, 'muted')).toBe(false)

  const before = Number(await prop(page, 'volume'))
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => prop(page, 'volume')).toBeLessThan(before)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => prop(page, 'volume')).toBeCloseTo(before, 2)
})

/** Raise the volume's popup, as a person would: the pointer onto the playing
 *  video brings the bar up, then onto the volume button. */
async function volumePopup(page: Page) {
  const v = (await player(page).boundingBox())!
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2)
  await page.getByRole('button', { name: /^Mute/ }).hover()
}

test('the boost raises just this video, and is gone on coming back', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await volumePopup(page)
  const boost = page.getByTestId('boost-button')
  await boost.click()
  await expect(boost).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('boost-readout')).toBeAttached()
  // The audio now runs through WebAudio — which a file served from another
  // origin, or a graph built wrong, would have refused.
  expect(errors).toEqual([])

  await watch(page, 'e2eMarks000')
  await watch(page, VIDEO)
  await volumePopup(page)
  await expect(page.getByTestId('boost-button')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('boost-readout')).toHaveCount(0)
})

test('focus mode keeps the bar down while paused, until the pointer is over the video', async ({ page }) => {
  const bar = page.getByTestId('track-rail').locator('xpath=ancestor::div[contains(@class, "bg-gradient-to-t")]')
  const opacity = () => bar.evaluate((el) => Number(getComputedStyle(el).opacity))
  const away = async () => {
    const v = (await player(page).boundingBox())!
    await page.mouse.move(v.x + v.width / 2, v.y + v.height + 40)  // below the player
  }

  // Ordinarily, a paused player keeps its bar.
  await pause(page)
  await away()
  await page.waitForTimeout(500)
  expect(await opacity()).toBe(1)

  await page.getByTestId('focus-button').click()
  await expect(page.getByTestId('focus-button')).toHaveAttribute('aria-pressed', 'true')
  await away()
  await expect.poll(opacity).toBe(0)

  const v = (await player(page).boundingBox())!
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2)
  await expect.poll(opacity).toBe(1)

  // A preference, not a page state: it's still on after a reload.
  await page.reload()
  await expect(page.getByTestId('focus-button')).toHaveAttribute('aria-pressed', 'true')
})
